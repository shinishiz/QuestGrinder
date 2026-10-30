/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 chess
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import { useTimer } from "@utils/react";
import type { IconProps } from "@utils/types";
import type { Quest } from "@vencord/discord-types";
import { QuestTaskType } from "@vencord/discord-types/enums";
import { createRoot, QuestStore, React, useLayoutEffect, useRef, useState, useStateFromStores } from "@webpack/common";
import type { PointerEvent } from "react";
import type { Root } from "react-dom/client";

import { t } from "./i18n";
import { canRun, categoryLabel, emit, enqueue, enqueueAll, estimateProgress, estimateQueueSeconds, getBatchProgress, getBlocker, getDoneToday, getJob, getJobs, getProgress, getQuests, getRewardCategory, getTask, getVersion, isCompleted, isIgnored, isLimitReached, isVideo, type Job, matchesFilter, openQuestPage, refreshQuests, REWARD_CATEGORIES, type RewardCategory, stop, stopAll, subscribe, toggleFilter, toggleIgnored, ui } from "./questEngine";
import { settings } from "./settings";

const cl = classNameFactory("vc-qg-");

const PANEL_WIDTH = 380;
const MAIN_CATEGORIES: RewardCategory[] = ["orbs", "decoration", "item"];

export function QuestIcon({ height = 20, width = 20, className }: IconProps) {
    return (
        <svg viewBox="0 0 24 24" width={width} height={height} fill="currentColor" className={className}>
            <path d="M7.5 21.7a8.95 8.95 0 0 1 9 0 1 1 0 0 0 1-1.73c-.6-.35-1.24-.64-1.9-.87.54-.3 1.05-.65 1.52-1.07a3.98 3.98 0 0 0 5.49-1.8.77.77 0 0 0-.24-.95 3.98 3.98 0 0 0-2.02-.76A4 4 0 0 0 23 10.47a.76.76 0 0 0-.71-.71 4.06 4.06 0 0 0-1.6.22 3.99 3.99 0 0 0 .54-5.35.77.77 0 0 0-.95-.24c-.75.36-1.37.95-1.77 1.67V6a4 4 0 0 0-4.9-3.9.77.77 0 0 0-.6.72 4 4 0 0 0 3.7 4.17c.89 1.3 1.3 2.95 1.3 4.51 0 3.66-2.75 6.5-6 6.5s-6-2.84-6-6.5c0-1.56.41-3.21 1.3-4.51A4 4 0 0 0 11 2.82a.77.77 0 0 0-.6-.72 4.01 4.01 0 0 0-4.9 3.96A4.02 4.02 0 0 0 3.73 4.4a.77.77 0 0 0-.95.24 3.98 3.98 0 0 0 .55 5.35 4 4 0 0 0-1.6-.22.76.76 0 0 0-.72.71l-.01.28a4 4 0 0 0 2.65 3.77c-.75.06-1.45.33-2.02.76-.3.22-.4.62-.24.95a4 4 0 0 0 5.49 1.8c.47.42.98.78 1.53 1.07-.67.23-1.3.52-1.91.87a1 1 0 1 0 1 1.73Z" />
        </svg>
    );
}

const Glyph = ({ d }: { d: string; }) => (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d={d} />
    </svg>
);

const ICON_MINIMIZE = "M5 12h14";
const ICON_EXPAND = "M6 15l6-6 6 6";
const ICON_CLOSE = "M6 6l12 12M18 6L6 18";
const ICON_REFRESH = "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6";
const ICON_HIDE = "M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7a13 13 0 0 1-2.6 3.6M6.3 6.3C4 7.8 2.6 10 2 12c1 2.5 5 7 10 7a9.6 9.6 0 0 0 5.7-1.7";

export const PageButton = ErrorBoundary.wrap(() => {
    useEngine();
    useTimer({ interval: 1000 });
    const jobs = getJobs();
    const [current] = jobs;

    let label = "QuestGrinder";
    if (current) {
        const { position, total } = getBatchProgress();
        const step = current.status === "running"
            ? `${Math.floor(estimateProgress(current) / current.target * 100)}%`
            : current.status === "waiting" ? t("pausa", "paused") : t("começando", "starting");
        label = total > 1 ? `${position}/${total} ${step}` : step;
    }

    return (
        <button className={cl("page-btn", { working: !!current })} onClick={togglePanel} title={jobs.length > 1 ? t(`${jobs.length - 1} na fila depois desta`, `${jobs.length - 1} queued after this one`) : undefined}>
            <QuestIcon width={16} height={16} />
            <span>{label}</span>
        </button>
    );
}, { noop: true });

export function useEngine() {
    return React.useSyncExternalStore(subscribe, getVersion);
}

// ── Montagem fora da árvore do Discord ──────────────────────────────

let root: Root | null = null;
let host: HTMLDivElement | null = null;

export function openPanel() {
    if (!root) {
        host = document.createElement("div");
        host.className = cl("host");
        document.body.appendChild(host);
        root = createRoot(host);
        root.render(<ErrorBoundary noop><PanelHost /></ErrorBoundary>);
    }
    ui.open = true;
    emit();
    void refreshQuests();
}

export function togglePanel() {
    if (ui.open) {
        ui.open = false;
        emit();
    } else {
        openPanel();
    }
}

export function unmountPanel() {
    root?.unmount();
    host?.remove();
    root = host = null;
    ui.open = false;
}

// ── Formatação ──────────────────────────────────────────────────────

function formatTime(seconds: number): string {
    const total = Math.max(0, Math.ceil(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total % 3600 / 60);
    const s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function formatEta(seconds: number): string {
    if (seconds < 60) return t("menos de 1 min", "under 1 min");
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

function formatExpiry(expiresAt: string): { text: string; urgent: boolean; } {
    const hours = (Date.parse(expiresAt) - Date.now()) / 3_600_000;
    if (hours < 24) return { text: t(`expira em ${Math.max(1, Math.floor(hours))}h`, `expires in ${Math.max(1, Math.floor(hours))}h`), urgent: true };
    const days = Math.floor(hours / 24);
    return { text: t(`expira em ${days}d`, `expires in ${days}d`), urgent: days <= 2 };
}

function taskLabel(quest: Quest): string {
    const task = getTask(quest);
    if (!task) return t("Outro tipo", "Other");
    if (isVideo(task)) return t("Vídeo", "Video");
    return task.type === QuestTaskType.PLAY_ACTIVITY ? t("Atividade", "Activity") : t("Jogo", "Game");
}

function jobStatus(job: Job, position: number): string {
    switch (job.status) {
        case "running": return t(`Faltam ${formatTime(job.target - estimateProgress(job))}`, `${formatTime(job.target - estimateProgress(job))} left`);
        case "enrolling": return t("Aceitando", "Accepting");
        case "waiting": return t(`Começa em ${formatTime((job.startsAt - Date.now()) / 1000)}`, `Starts in ${formatTime((job.startsAt - Date.now()) / 1000)}`);
        case "queued": return t(`${position + 1}º na fila`, `#${position + 1} in queue`);
    }
}

// ── Componentes ─────────────────────────────────────────────────────

const sameQuests = (a: Quest[], b: Quest[]) => a.length === b.length && a.every((quest, i) => quest === b[i]);

function QuestRow({ quest }: { quest: Quest; }) {
    const task = getTask(quest);
    const job = getJob(quest.id);
    const jobs = getJobs();
    const runnable = canRun(quest);
    const target = task?.target ?? 0;
    const progress = job ? estimateProgress(job) : task ? getProgress(quest, task) : 0;
    const percent = target ? Math.min(100, progress / target * 100) : 0;
    const label = taskLabel(quest);
    const expiry = formatExpiry(quest.config.expiresAt);
    const reward = quest.config.rewardsConfig?.rewards?.[0]?.messages?.name;
    const category = getRewardCategory(quest);
    const active = job?.status === "running" || job?.status === "enrolling";
    const completed = isCompleted(quest);
    const ignored = isIgnored(quest.id);

    let status: string;
    if (job) status = jobStatus(job, jobs.indexOf(job));
    else if (completed) status = t("Falta resgatar", "Ready to claim");
    else if (ignored) status = t("Ignorada", "Ignored");
    else if (!task) status = t("Tipo não suportado", "Unsupported type");
    else if (!runnable) status = t("Só no app do PC", "Desktop app only");
    else if (!quest.userStatus?.enrolledAt) status = t("Não aceita", "Not accepted");
    else if (progress > 0) status = t("Parada", "Paused");
    else status = t("Aceita", "Accepted");

    return (
        <div className={cl("row", { active, queued: !!job && !active, disabled: ignored || (!runnable && !completed) })}>
            <div className={cl("row-top")}>
                <div className={cl("row-info")}>
                    <span className={cl("row-name")} title={quest.config.messages.questName}>{quest.config.messages.questName}</span>
                    <span className={cl("row-meta")}>
                        <span className={cl("chip")}>{label}</span>
                        {category !== "orbs" && <span className={cl("chip")}>{categoryLabel(category)}</span>}
                        {reward && <span className={cl("reward")} title={reward}>{reward}</span>}
                        <span className={cl({ urgent: expiry.urgent })}>{expiry.text}</span>
                    </span>
                </div>
                {job ? <button className={cl("btn", "btn-ghost")} onClick={() => stop(quest.id)}>{active ? t("Parar", "Stop") : t("Tirar", "Remove")}</button>
                    : completed ? <button className={cl("btn", "btn-primary")} onClick={() => openQuestPage(quest.id)}>{t("Resgatar", "Claim")}</button>
                        : ignored ? <button className={cl("btn", "btn-ghost")} onClick={() => toggleIgnored(quest.id)}>{t("Voltar", "Restore")}</button>
                            : (
                                <>
                                    <button className={cl("icon-btn")} title={t("Ignorar", "Ignore")} onClick={() => toggleIgnored(quest.id)}>
                                        <Glyph d={ICON_HIDE} />
                                    </button>
                                    <button className={cl("btn", "btn-primary")} disabled={!runnable} onClick={() => enqueue([quest])}>{t("Fazer", "Start")}</button>
                                </>
                            )}
            </div>
            {task && (
                <div className={cl("bar")}>
                    <div className={cl("bar-fill", { "bar-live": active })} style={{ width: `${percent}%` }} />
                </div>
            )}
            <div className={cl("row-status")}>
                <span>{status}</span>
                {task && <span>{Math.floor(percent)}%</span>}
            </div>
        </div>
    );
}

function clampPosition(x: number, y: number, height: number) {
    return {
        x: Math.max(0, Math.min(x, window.innerWidth - PANEL_WIDTH)),
        y: Math.max(0, Math.min(y, window.innerHeight - height)),
    };
}

function PanelHost() {
    useEngine();
    return ui.open ? <Panel /> : null;
}

function Panel() {
    useTimer({ interval: 1000 });
    const allQuests = useStateFromStores([QuestStore], getQuests, [settings.store.ignoredQuests], sameQuests);
    const filter = settings.store.rewardFilter;
    const quests = allQuests.filter(matchesFilter);
    const categories = (Object.keys(REWARD_CATEGORIES) as RewardCategory[])
        .filter(category => MAIN_CATEGORIES.includes(category) || allQuests.some(quest => getRewardCategory(quest) === category));
    const saved = settings.store.panelPosition;
    const [rawPosition, setPosition] = useState(() => saved.x < 0
        ? { x: window.innerWidth - PANEL_WIDTH - 24, y: 72 }
        : saved);
    const drag = useRef<{ dx: number; dy: number; } | null>(null);
    const windowRef = useRef<HTMLDivElement>(null);
    const [height, setHeight] = useState(48);
    // Recalculado a cada render: a janela pode ter encolhido, mudado de monitor ou o painel expandido.
    const position = clampPosition(rawPosition.x, rawPosition.y, height);

    useLayoutEffect(() => {
        const measured = windowRef.current?.offsetHeight;
        if (measured && measured !== height) setHeight(measured);
    });

    const jobs = getJobs();
    const blocker = getBlocker();
    const pending = quests.filter(quest => canRun(quest) && !getJob(quest.id) && !isIgnored(quest.id));
    const open = quests.filter(quest => !isCompleted(quest)).length;
    const limit = settings.store.dailyLimit;
    const summary = [
        jobs.length
            ? t(`${jobs.length} na fila, faltam ${formatEta(estimateQueueSeconds())}`, `${jobs.length} queued, ${formatEta(estimateQueueSeconds())} left`)
            : t(`${open} ${open === 1 ? "missão" : "missões"}`, `${open} ${open === 1 ? "quest" : "quests"}`),
        limit > 0 && t(`${getDoneToday()} de ${limit} hoje`, `${getDoneToday()} of ${limit} today`),
    ].filter(Boolean).join(", ");

    function onPointerDown(event: PointerEvent<HTMLElement>) {
        if ((event.target as HTMLElement).closest("button")) return;
        drag.current = { dx: event.clientX - position.x, dy: event.clientY - position.y };
        event.currentTarget.setPointerCapture(event.pointerId);
    }

    function onPointerMove(event: PointerEvent<HTMLElement>) {
        if (drag.current) setPosition(clampPosition(event.clientX - drag.current.dx, event.clientY - drag.current.dy, height));
    }

    function onPointerUp(event: PointerEvent<HTMLElement>) {
        if (!drag.current) return;
        const dropped = clampPosition(event.clientX - drag.current.dx, event.clientY - drag.current.dy, height);
        drag.current = null;
        setPosition(dropped);
        settings.store.panelPosition = dropped;
    }

    return (
        <div ref={windowRef} className={cl("window", { minimized: ui.minimized })} style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}>
            <header className={cl("header")} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
                <span className={cl("dot", { working: jobs.length > 0 })} />
                <div className={cl("title")}>
                    <strong>QuestGrinder</strong>
                    <span>{summary}</span>
                </div>
                <button className={cl("icon-btn")} title={ui.minimized ? t("Expandir", "Expand") : t("Minimizar", "Minimize")} onClick={() => { ui.minimized = !ui.minimized; emit(); }}>
                    <Glyph d={ui.minimized ? ICON_EXPAND : ICON_MINIMIZE} />
                </button>
                <button className={cl("icon-btn")} title={t("Fechar (a fila continua)", "Close (the queue keeps running)")} onClick={() => { ui.open = false; emit(); }}>
                    <Glyph d={ICON_CLOSE} />
                </button>
            </header>

            {!ui.minimized && (
                <>
                    <div className={cl("toolbar")}>
                        <button className={cl("btn", "btn-primary", "btn-wide")} disabled={!pending.length || !!blocker || isLimitReached()} onClick={enqueueAll}>
                            {t("Fazer todas", "Start all")}
                        </button>
                        <button className={cl("btn", "btn-ghost")} disabled={!jobs.length} onClick={stopAll}>{t("Parar", "Stop")}</button>
                        <button className={cl("btn", "btn-ghost", "btn-square")} title={t("Buscar missões novas", "Check for new quests")} onClick={() => refreshQuests(true)}>
                            <Glyph d={ICON_REFRESH} />
                        </button>
                    </div>

                    <div className={cl("filters")}>
                        <button className={cl("filter", { "filter-on": !filter.length })} onClick={() => toggleFilter(null)}>{t("Todas", "All")}</button>
                        {categories.map(category => (
                            <button key={category} className={cl("filter", { "filter-on": filter.includes(category) })} onClick={() => toggleFilter(category)}>
                                {categoryLabel(category)}
                            </button>
                        ))}
                    </div>

                    {blocker && <div className={cl("alert")}>{blocker}</div>}

                    <div className={cl("list")}>
                        {quests.length
                            ? quests.map(quest => <QuestRow key={quest.id} quest={quest} />)
                            : <div className={cl("empty")}>{allQuests.length ? t("Nenhuma missão nessa categoria.", "No quests in this category.") : t("Nenhuma missão disponível.", "No quests available.")}</div>}
                    </div>
                </>
            )}
        </div>
    );
}
