/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 chess
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { isPluginEnabled } from "@api/PluginManager";
import { Logger } from "@utils/Logger";
import type { Quest, QuestTask } from "@vencord/discord-types";
import { QuestRewardType, QuestTargetedContent, QuestTaskJoinOperator, QuestTaskType } from "@vencord/discord-types/enums";
import { findByCodeLazy, findLazy } from "@webpack";
import { FluxDispatcher, NavigationRouter, QuestStore, showToast } from "@webpack/common";

import { joinList, t } from "./i18n";
import { settings } from "./settings";

export const logger = new Logger("QuestGrinder");

interface HeartbeatOptions {
    questId: string;
    applicationId?: string;
    terminal: boolean;
}

type UserStatus = Quest["userStatus"];

// Funções do próprio Discord: as requisições saem iguais às do app oficial.
const reportVideoProgress: (questId: string, timestamp: number) => Promise<unknown> = findByCodeLazy(".QUESTS_VIDEO_PROGRESS(");
const sendHeartbeat: (options: HeartbeatOptions) => Promise<unknown> = findByCodeLazy(".QUESTS_HEARTBEAT(");
const enrollInQuest: (questId: string, metadata: object) => Promise<{ type: string; error?: unknown; }> = findByCodeLazy('type:"QUESTS_ENROLL_BEGIN",');
const sortQuests: (quests: Quest[], options: { sortMethod: string; filters: unknown[]; }) => Quest[] = findByCodeLazy("sortMethod:", "isRenewableEndDateSortEnabled");
const fetchCurrentQuests: () => Promise<unknown> = findByCodeLazy("QUESTS_FETCH_CURRENT_QUESTS_BEGIN");
const QuestCTA: { START_QUEST: string; ACCEPT_QUEST: string; } = findLazy(m => m?.START_QUEST != null && m?.ACCEPT_QUEST != null);

const VIDEO_TASKS: QuestTaskType[] = [QuestTaskType.WATCH_VIDEO, QuestTaskType.WATCH_VIDEO_ON_MOBILE];
const PLAY_TASKS: QuestTaskType[] = [QuestTaskType.PLAY_ON_DESKTOP, QuestTaskType.PLAY_ACTIVITY];
const SUPPORTED_TASKS = [...VIDEO_TASKS, ...PLAY_TASKS];
export const CONFLICTING_PLUGINS = ["Questify", "QuestCompleter", "QuestAutoComplete"];

const VIDEO_REPORT_MS = [6_000, 8_000] as const;
const COOLDOWN_MS = [20_000, 45_000] as const;
const ENROLL_SETTLE_MS = [2_000, 5_000] as const;
const HEARTBEAT_MAX_MS = 60_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;
const RETRY_MS = 2_500;

class QuestError extends Error { }

const rateLimited = () => t("O Discord limitou as requisições. Tente de novo mais tarde.", "Discord is rate limiting requests. Try again later.");

function isRateLimited(error: unknown): boolean {
    return typeof error === "object" && error !== null && "status" in error && error.status === 429;
}

const random = (min: number, max: number) => min + Math.random() * (max - min);

function wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);

        const id = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);

        function onAbort() {
            clearTimeout(id);
            reject(signal.reason);
        }

        signal.addEventListener("abort", onAbort, { once: true });
    });
}

// Para de esperar quando a fila é parada ou o Discord demora demais; uma resposta atrasada é ignorada.
function guard<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);

        const timeout = setTimeout(() => finish(() => reject(new Error("O Discord não respondeu a tempo."))), REQUEST_TIMEOUT_MS);

        function finish(callback: () => void) {
            clearTimeout(timeout);
            signal.removeEventListener("abort", onAbort);
            callback();
        }

        function onAbort() {
            finish(() => reject(signal.reason));
        }

        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
}

// ── Leitura das missões ─────────────────────────────────────────────

export function getTask(quest: Quest): QuestTask | null {
    const config = quest.config.taskConfigV2;
    if (!config) return null;
    if (config.joinOperator === QuestTaskJoinOperator.AND && Object.keys(config.tasks).length > 1) return null;

    for (const type of SUPPORTED_TASKS) {
        const task = config.tasks[type];
        if (task) return task;
    }
    return null;
}

export const isVideo = (task: QuestTask) => VIDEO_TASKS.includes(task.type);

export const isCompleted = (quest: Quest) => quest.userStatus?.completedAt != null;
export const isIgnored = (questId: string) => settings.store.ignoredQuests.includes(questId);

export function toggleIgnored(questId: string) {
    const list = settings.store.ignoredQuests;
    settings.store.ignoredQuests = list.includes(questId) ? list.filter(id => id !== questId) : [...list, questId];
    emit();
}

export const REWARD_CATEGORIES = {
    orbs: ["Orbs", "Orbs"],
    decoration: ["Decoração", "Decoration"],
    item: ["Item de jogo", "In-game item"],
    nitro: ["Nitro", "Nitro"],
    other: ["Outras", "Other"],
} as const;

export type RewardCategory = keyof typeof REWARD_CATEGORIES;

export function categoryLabel(category: RewardCategory): string {
    const [pt, en] = REWARD_CATEGORIES[category];
    return t(pt, en);
}

export function getRewardCategory(quest: Quest): RewardCategory {
    switch (quest.config.rewardsConfig?.rewards?.[0]?.type) {
        case QuestRewardType.VIRTUAL_CURRENCY: return "orbs";
        case QuestRewardType.COLLECTIBLE: return "decoration";
        case QuestRewardType.REWARD_CODE:
        case QuestRewardType.IN_GAME: return "item";
        case QuestRewardType.FRACTIONAL_PREMIUM: return "nitro";
        default: return "other";
    }
}

export function matchesFilter(quest: Quest): boolean {
    const filter = settings.store.rewardFilter;
    return !filter.length || filter.includes(getRewardCategory(quest));
}

export function toggleFilter(category: RewardCategory | null) {
    const filter = settings.store.rewardFilter;
    settings.store.rewardFilter = category == null ? [] : filter.includes(category) ? filter.filter(c => c !== category) : [...filter, category];
    emit();
}

export function canRun(quest: Quest): boolean {
    const task = getTask(quest);
    return task != null && !isCompleted(quest) && (isVideo(task) || IS_DISCORD_DESKTOP);
}

export const openQuestPage = (questId?: string) => NavigationRouter.transitionTo(questId ? `/quest-home#${questId}` : "/quest-home");

export function getProgress(quest: Quest, task: QuestTask): number {
    if (quest.userStatus?.completedAt) return task.target;

    const progress = quest.userStatus?.progress;
    if (!progress) return 0;

    return isVideo(task)
        ? Math.max(progress.WATCH_VIDEO?.value ?? 0, progress.WATCH_VIDEO_ON_MOBILE?.value ?? 0)
        : progress[task.type]?.value ?? 0;
}

// Não concluídas primeiro, depois concluídas esperando resgate, depois ignoradas.
export function getQuests(): Quest[] {
    const now = Date.now();
    const rank = (quest: Quest) => isIgnored(quest.id) ? 2 : isCompleted(quest) ? 1 : 0;
    return [...QuestStore.quests.values()]
        .filter(quest => !quest.preview && !quest.userStatus?.claimedAt && Date.parse(isCompleted(quest)
            ? quest.config.rewardsConfig?.rewardsExpireAt ?? quest.config.expiresAt
            : quest.config.expiresAt) > now)
        .sort((a, b) => rank(a) - rank(b) || Date.parse(a.config.expiresAt) - Date.parse(b.config.expiresAt));
}

export function checkNewQuests() {
    const quests = getQuests().filter(quest => !isCompleted(quest));
    const { ready, ids } = settings.store.seenQuests;
    const fresh = quests.filter(quest => !ids.includes(quest.id));
    settings.store.seenQuests = { ready: true, ids: [...new Set([...ids, ...quests.map(quest => quest.id)])].slice(-300) };

    // Na primeira vez só memoriza o que já existe, sem avisar.
    if (!ready || !fresh.length || !settings.store.newQuestNotifications) return;

    const [first] = fresh;
    const reward = first.config.rewardsConfig?.rewards?.[0]?.messages?.name;
    showNotification({
        title: fresh.length === 1 ? t("Missão nova", "New quest") : t(`${fresh.length} missões novas`, `${fresh.length} new quests`),
        body: fresh.length === 1
            ? reward ? `${first.config.messages.questName}, ${reward}` : first.config.messages.questName
            : fresh.map(quest => quest.config.messages.questName).join(", "),
        onClick: () => openQuestPage(first.id),
    });
}

let lastFetch = 0;

export async function refreshQuests(force = false): Promise<void> {
    if (Date.now() - lastFetch < (force ? 30_000 : 10 * 60_000)) return;
    lastFetch = Date.now();

    try {
        await fetchCurrentQuests();
    } catch (error) {
        logger.error("Falha ao buscar as missões", error);
    }
}

// ── Estado observável ───────────────────────────────────────────────

export type JobStatus = "queued" | "waiting" | "enrolling" | "running";

export interface Job {
    questId: string;
    name: string;
    status: JobStatus;
    progress: number;
    target: number;
    updatedAt: number;
    startsAt: number;
}

const queue: Job[] = [];
const listeners = new Set<() => void>();
let version = 0;
let controller: AbortController | null = null;
let working = false;
const batchDone: string[] = [];
let stoppedByUser = false;

export const patchStatus = { video: false, heartbeat: false };
export const ui = { open: false, minimized: false };

export function emit() {
    version++;
    listeners.forEach(listener => listener());
}

export function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

export const getVersion = () => version;
export const getJobs = (): readonly Job[] => queue;
// Concluídas da leva contam até serem resgatadas; depois saem da conta.
export function getBatchProgress() {
    const waitingClaim = batchDone.filter(id => !QuestStore.getQuest(id)?.userStatus?.claimedAt).length;
    return { position: waitingClaim + 1, total: waitingClaim + queue.length };
}
export const getJob = (questId: string) => queue.find(job => job.questId === questId);

export function estimateProgress(job: Job): number {
    return job.status === "running"
        ? Math.min(job.target, job.progress + (Date.now() - job.updatedAt) / 1000)
        : job.progress;
}

export function estimateQueueSeconds(): number {
    const averageCooldown = (COOLDOWN_MS[0] + COOLDOWN_MS[1]) / 2000;
    return queue.reduce((total, job, index) => total
        + Math.max(0, job.target - estimateProgress(job))
        + (job.status === "waiting" ? Math.max(0, (job.startsAt - Date.now()) / 1000) : index > 0 ? averageCooldown : 0), 0);
}

const today = () => new Date().toLocaleDateString("sv");

export function getDoneToday(): number {
    const { day, count } = settings.store.dailyCount;
    return day === today() ? count : 0;
}

export function isLimitReached(): boolean {
    const limit = settings.store.dailyLimit;
    return limit > 0 && getDoneToday() >= limit;
}

const limitMessage = () => t(`Limite de ${settings.store.dailyLimit} missões por dia atingido.`, `Daily limit of ${settings.store.dailyLimit} quests reached.`);

export function getBlocker(): string | null {
    const conflicts = CONFLICTING_PLUGINS.filter(isPluginEnabled);
    if (conflicts.length) return t(`Desative ${joinList(conflicts)} e reinicie o Discord.`, `Disable ${joinList(conflicts)} and restart Discord.`);
    if (!patchStatus.video || !patchStatus.heartbeat) return t("Os patches não carregaram. Reinicie o Discord, e se continuar, o plugin precisa ser atualizado.", "The patches didn't load. Restart Discord; if it keeps happening, the plugin needs an update.");
    return null;
}

function notify(text: string, variant: "default" | "success" | "critical" = "default") {
    logger.info(text);
    if (settings.store.showNotifications) showToast({ text, variant });
}

function notifySystem(title: string, body: string) {
    if (settings.store.systemNotifications) showNotification({ title, body, onClick: () => openQuestPage() });
}

// ── Fila ────────────────────────────────────────────────────────────

export function enqueue(quests: Quest[]): void {
    const blocker = getBlocker() ?? (isLimitReached() ? limitMessage() : null);
    if (blocker) {
        notify(blocker, "critical");
        return;
    }

    let added = 0;
    for (const quest of quests) {
        const task = getTask(quest);
        if (!task || !canRun(quest) || getJob(quest.id)) continue;

        queue.push({
            questId: quest.id,
            name: quest.config.messages.questName,
            status: "queued",
            progress: getProgress(quest, task),
            target: task.target,
            updatedAt: Date.now(),
            startsAt: 0,
        });
        added++;
    }

    if (!added) return;
    emit();
    if (!working) void work();
}

export const enqueueAll = () => enqueue(getQuests().filter(quest => !isIgnored(quest.id) && matchesFilter(quest)));

export function stop(questId: string): void {
    const index = queue.findIndex(job => job.questId === questId);
    if (index === -1) return;

    if (index === 0) {
        controller?.abort();
    } else {
        queue.splice(index, 1);
        emit();
    }
}

export function stopAll(): void {
    if (!queue.length) return;
    stoppedByUser = true;
    queue.length = 0;
    batchDone.length = 0;
    controller?.abort();
    emit();
}

async function work(): Promise<void> {
    working = true;
    stoppedByUser = false;
    let first = true;
    let done = 0;
    let failure: string | null = null;

    while (queue.length) {
        const [job] = queue;
        const current = controller = new AbortController();

        if (isLimitReached()) {
            failure = limitMessage();
            notify(failure, "critical");
            queue.length = 0;
            break;
        }

        try {
            if (!first) {
                const ms = random(...COOLDOWN_MS);
                job.status = "waiting";
                job.startsAt = Date.now() + ms;
                emit();
                await wait(ms, current.signal);
            }

            await runJob(job, current.signal);
            done++;
            batchDone.push(job.questId);
            settings.store.dailyCount = { day: today(), count: getDoneToday() + 1 };
            notify(t(`Missão "${job.name}" concluída.`, `Quest "${job.name}" completed.`), "success");
        } catch (error) {
            if (!current.signal.aborted) {
                logger.error(`A missão "${job.name}" falhou`, error);
                failure = error instanceof QuestError ? error.message : t(`A missão "${job.name}" falhou.`, `Quest "${job.name}" failed.`);
                notify(failure, "critical");
                queue.length = 0;
            }
        }

        first = false;
        const index = queue.indexOf(job);
        if (index !== -1) queue.splice(index, 1);
        emit();
    }

    controller = null;
    working = false;
    batchDone.length = 0;
    emit();

    if (failure) notifySystem(t("QuestGrinder parou", "QuestGrinder stopped"), failure);
    else if (done && !stoppedByUser) notifySystem(t("Fila concluída", "Queue finished"), done === 1
        ? t("1 missão feita, falta resgatar.", "1 quest done, ready to claim.")
        : t(`${done} missões feitas, falta resgatar.`, `${done} quests done, ready to claim.`));
}

function setProgress(job: Job, value: number) {
    job.progress = Math.min(job.target, value);
    job.updatedAt = Date.now();
    emit();
}

async function runJob(job: Job, signal: AbortSignal): Promise<void> {
    let quest = QuestStore.getQuest(job.questId);
    const task = quest && getTask(quest);
    if (!quest || !task) throw new QuestError(t(`A missão "${job.name}" não está mais disponível.`, `Quest "${job.name}" is no longer available.`));

    if (!quest.userStatus?.enrolledAt) {
        job.status = "enrolling";
        emit();
        quest = await enroll(quest, task, signal);
        await wait(random(...ENROLL_SETTLE_MS), signal);
    }

    job.status = "running";
    setProgress(job, getProgress(quest, task));

    if (isVideo(task)) await runVideo(job, quest, task, signal);
    else await runHeartbeat(job, quest, task, signal);

    // Só conta como feita quando o Discord marca a missão como concluída.
    for (let i = 0; !QuestStore.getQuest(job.questId)?.userStatus?.completedAt; i++) {
        if (i === 10) void refreshQuests(true);
        if (i === 20) throw new QuestError(t(`O Discord não confirmou a missão "${job.name}".`, `Discord didn't confirm quest "${job.name}".`));
        await wait(500, signal);
    }
}

async function withRetry<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await guard(action(), signal);
        } catch (error) {
            if (signal.aborted) throw error;
            if (isRateLimited(error)) throw new QuestError(rateLimited());
            if (attempt >= ATTEMPTS) throw error;
            logger.warn(`Tentativa ${attempt} falhou, tentando de novo`, error);
            await wait(RETRY_MS, signal);
        }
    }
}

// ── Inscrição ───────────────────────────────────────────────────────

async function enroll(quest: Quest, task: QuestTask, signal: AbortSignal): Promise<Quest> {
    let position = -1;
    try {
        position = sortQuests([...QuestStore.quests.values()], { sortMethod: "suggested", filters: [] }).findIndex(q => q.id === quest.id);
    } catch (error) {
        logger.warn("Não deu pra calcular a posição da missão na página", error);
    }

    const startsDirectly = task.type === QuestTaskType.WATCH_VIDEO || task.type === QuestTaskType.PLAY_ACTIVITY;
    const result = await guard(enrollInQuest(quest.id, {
        questContent: QuestTargetedContent.QUEST_HOME_DESKTOP,
        questContentCTA: startsDirectly ? QuestCTA.START_QUEST : QuestCTA.ACCEPT_QUEST,
        sourceQuestContent: QuestTargetedContent.QUEST_HOME_DESKTOP,
        questContentPosition: position === -1 ? undefined : position,
        questContentRowIndex: position === -1 ? undefined : Math.floor(position / 3),
    }), signal);

    if (isRateLimited(result.error)) throw new QuestError(rateLimited());

    for (let i = 0; i < 20; i++) {
        const updated = QuestStore.getQuest(quest.id);
        if (updated?.userStatus?.enrolledAt) return updated;
        await wait(500, signal);
    }

    throw new QuestError(t(`Não deu pra aceitar a missão "${quest.config.messages.questName}".`, `Couldn't accept quest "${quest.config.messages.questName}".`));
}

// ── Vídeo ───────────────────────────────────────────────────────────

async function runVideo(job: Job, quest: Quest, task: QuestTask, signal: AbortSignal): Promise<void> {
    const enrolledAt = Date.parse(quest.userStatus?.enrolledAt ?? "") || Date.now();
    let { progress } = job;
    let last = Date.now();

    while (progress < task.target) {
        await wait(random(...VIDEO_REPORT_MS), signal);

        const now = Date.now();
        // Nunca à frente do tempo real desde a inscrição.
        const next = Math.min(task.target, progress + (now - last) / 1000, (now - enrolledAt) / 1000);
        last = now;
        if (next <= progress) continue;

        progress = next;
        await withRetry(() => reportVideoProgress(quest.id, progress), signal);
        setProgress(job, progress);

        if (QuestStore.getQuest(quest.id)?.userStatus?.completedAt) return;
    }
}

// ── Jogo e atividade ────────────────────────────────────────────────

function heartbeat(questId: string, applicationId: string, terminal: boolean): Promise<UserStatus> {
    return new Promise((resolve, reject) => {
        let done = false;
        const timeout = setTimeout(() => finish(() => reject(new Error("O Discord não respondeu ao heartbeat."))), HEARTBEAT_TIMEOUT_MS);

        function finish(callback: () => void) {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onSuccess);
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_FAILURE", onFailure);
            callback();
        }

        function onSuccess(event: { questId: string; userStatus: UserStatus; }) {
            if (event.questId === questId) finish(() => resolve(event.userStatus));
        }

        function onFailure(event: { questId: string; error?: unknown; }) {
            if (event.questId === questId) finish(() => reject(event.error ?? new Error("O Discord recusou o heartbeat.")));
        }

        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", onSuccess);
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_FAILURE", onFailure);
        sendHeartbeat({ questId, applicationId, terminal }).catch(error => finish(() => reject(error)));
    });
}

async function runHeartbeat(job: Job, quest: Quest, task: QuestTask, signal: AbortSignal): Promise<void> {
    const applicationId = ("applications" in task ? task.applications[0]?.id : undefined) ?? quest.config.application.id;

    async function beat(terminal: boolean): Promise<boolean> {
        const status = await withRetry(() => heartbeat(quest.id, applicationId, terminal), signal);
        const value = status?.progress?.[task.type]?.value ?? job.progress;
        setProgress(job, value);
        return status?.completedAt != null || value >= task.target;
    }

    try {
        let done = await beat(false);
        while (!done) {
            const remainingMs = (task.target - job.progress) * 1000;
            await wait(remainingMs <= HEARTBEAT_MAX_MS ? remainingMs + 1000 : HEARTBEAT_MAX_MS, signal);
            done = await beat(false);
        }
        await beat(true);
    } catch (error) {
        // Ao parar, avisa o fim da sessão, como o app faz quando o jogo fecha.
        if (signal.aborted) heartbeat(quest.id, applicationId, true).catch(e => logger.warn("O heartbeat final falhou", e));
        throw error;
    }
}
