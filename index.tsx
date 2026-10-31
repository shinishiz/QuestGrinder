/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 chess
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButton, type ChatBarButtonFactory } from "@api/ChatButtons";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { openUserProfile } from "@utils/discord";
import { Margins } from "@utils/margins";
import definePlugin from "@utils/types";
import type { Quest } from "@vencord/discord-types";
import { onceReady } from "@webpack";

import { t } from "./i18n";
import { openPanel, PageButton, QuestIcon, togglePanel, unmountPanel, useEngine } from "./Panel";
import { checkNewQuests, enqueueAll, getJobs, patchStatus, refreshQuests, stopAll } from "./questEngine";
import { settings } from "./settings";
import managedStyle from "./styles.css?managed";
import { checkForUpdates } from "./updater";

const AUTHOR_ID = "461683460797628436";
// Mudar a cada release: é o que aparece nas configurações e confirma qual código está rodando.
const PLUGIN_VERSION = "1.0.4";
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let updateTimer: ReturnType<typeof setTimeout> | undefined;
let updateInterval: ReturnType<typeof setInterval> | undefined;
let newQuestTimer: ReturnType<typeof setTimeout> | undefined;
let autoStartTimer: ReturnType<typeof setTimeout> | undefined;

// O clique no avatar de autor abre o card de contribuidor do Equicord; aqui ele abre o perfil do Discord.
function onAuthorClick(event: MouseEvent) {
    const avatar = (event.target as Element | null)?.closest(`.vc-settings-modal-content img[src*="${AUTHOR_ID}"]`);
    if (!avatar) return;
    event.preventDefault();
    event.stopPropagation();
    openUserProfile(AUTHOR_ID);
}

const QuestGrinderButton: ChatBarButtonFactory = ({ isMainChat }) => {
    useEngine();
    if (!isMainChat) return null;

    return (
        <ChatBarButton tooltip="QuestGrinder" onClick={togglePanel}>
            <QuestIcon className={getJobs().length ? "vc-qg-chat-active" : undefined} />
        </ChatBarButton>
    );
};

export default definePlugin({
    name: "QuestGrinder",
    get description() {
        return t("Completa suas missões do Discord automaticamente.", "Automatically completes your Discord quests.");
    },
    authors: [{ name: "chess", id: 461683460797628436n }],
    settings,
    managedStyle,

    patches: [
        {
            // Tira o stack trace que o Discord anexa no progresso de vídeo e no heartbeat.
            find: "NetworkActionNames.QUEST_VIDEO_PROGRESS,",
            group: true,
            replacement: [
                {
                    match: /(async function \i\(\i,\i\)\{await \i\.\i\.post\(\{url:\i\.\i\.QUESTS_VIDEO_PROGRESS.{0,250}?stack_trace:)Error\(\)\.stack\?\?""/,
                    replace: '$self.markPatched("video");$1""'
                },
                {
                    match: /(async function \i\(\i\)\{let\{questId:\i,streamKey:\i.{0,450}?stack_trace:)Error\(\)\.stack\?\?""/,
                    replace: '$self.markPatched("heartbeat");$1""'
                }
            ]
        },
        {
            // Registra a ordenação "Não concluídas" no menu "Ordenar por".
            find: 'EXPIRING_SOON="expiring_soon"',
            replacement: {
                match: /(?<=\.RECENTLY_ENROLLED="recently_enrolled",)(?=(\i)\))/,
                replace: '$1.QUESTGRINDER="questgrinder",'
            }
        },
        {
            find: "has no rewards configured`",
            replacement: {
                match: /(?=case \i\.\i\.SUGGESTED:)/,
                replace: 'case"questgrinder":return"QuestGarden";'
            }
        },
        {
            find: 'CLAIMED="claimed",',
            replacement: {
                match: /(?=case \i\.\i\.SUGGESTED:default:)/,
                replace: 'case"questgrinder":return $self.compareQuests;'
            }
        },
        {
            // QuestGarden vira a ordenação padrão quando a URL não escolhe nenhuma.
            find: "GLOBAL_DISCOVERY_QUESTS,cardAlignment:",
            replacement: {
                match: /(?<=Object\.values\(\i\.\i\)\.find\(\i=>\i===\i\)\?\?null\)\?\?)\i\.\i\.SUGGESTED(?=\},\[\i\]\))/,
                replace: '"questgrinder"'
            }
        },
        {
            // Botão do painel ao lado do saldo de Orbs na página de missões.
            find: "GLOBAL_DISCOVERY_QUESTS,cardAlignment:",
            replacement: {
                match: /(?=\(0,\i\.jsx\)\(\i\.\i,\{analyticsPage:\i\.\i\.GLOBAL_DISCOVERY_QUESTS,cardAlignment:)/,
                replace: "$self.renderPageButton(),"
            }
        }
    ],

    markPatched(kind: keyof typeof patchStatus) {
        patchStatus[kind] = true;
    },

    compareQuests(a: Quest, b: Quest) {
        const rank = (quest: Quest) => quest.userStatus?.claimedAt ? 2 : quest.userStatus?.completedAt ? 1 : 0;
        return rank(a) - rank(b) || Date.parse(a.config.expiresAt) - Date.parse(b.config.expiresAt);
    },

    renderPageButton: () => <PageButton />,

    chatBarButton: {
        icon: QuestIcon,
        render: QuestGrinderButton,
    },

    get toolboxActions() {
        return { [t("Abrir painel", "Open panel")]: openPanel };
    },

    commands: [
        {
            name: "questgrinder",
            get description() { return t("Abre o painel do QuestGrinder.", "Opens the QuestGrinder panel."); },
            execute: () => { openPanel(); },
        },
    ],

    settingsAboutComponent: () => (
        <>
            <Paragraph>
                {t("Faz uma missão por vez, no mesmo ritmo do app, e para se der algum erro.", "Does one quest at a time, at the same pace as the app, and stops on any error.")}
            </Paragraph>
            <Paragraph className={Margins.top8}>{t(`Versão ${PLUGIN_VERSION}`, `Version ${PLUGIN_VERSION}`)}</Paragraph>
            <Button size="small" onClick={openPanel} className={Margins.top8}>{t("Abrir painel", "Open panel")}</Button>
        </>
    ),

    flux: {
        QUESTS_FETCH_CURRENT_QUESTS_SUCCESS() {
            clearTimeout(newQuestTimer);
            clearTimeout(autoStartTimer);
            newQuestTimer = setTimeout(checkNewQuests, 1000);
            autoStartTimer = setTimeout(() => settings.store.autoStart && enqueueAll(), 3000);
        },
        LOGOUT() {
            stopAll();
        },
    },

    start() {
        document.addEventListener("click", onAuthorClick, true);
        refreshTimer = setInterval(() => refreshQuests(), 30 * 60_000);
        onceReady.then(() => refreshQuests());
        updateTimer = setTimeout(checkForUpdates, 20_000);
        // Quem deixa o Discord aberto por dias também recebe.
        updateInterval = setInterval(checkForUpdates, 6 * 60 * 60_000);
    },

    stop() {
        document.removeEventListener("click", onAuthorClick, true);
        clearInterval(refreshTimer);
        clearTimeout(updateTimer);
        clearInterval(updateInterval);
        clearTimeout(newQuestTimer);
        clearTimeout(autoStartTimer);
        stopAll();
        unmountPanel();
    },
});
