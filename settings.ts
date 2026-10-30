/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 chess
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { t } from "./i18n";

export const settings = definePluginSettings({
    autoStart: {
        type: OptionType.BOOLEAN,
        get description() { return t("Começa sozinho as missões que aparecerem.", "Automatically starts new quests as they show up."); },
        default: false,
    },
    showNotifications: {
        type: OptionType.BOOLEAN,
        get description() { return t("Avisa quando uma missão termina ou dá erro.", "Notifies you when a quest finishes or fails."); },
        default: true,
    },
    systemNotifications: {
        type: OptionType.BOOLEAN,
        get description() { return t("Mostra uma notificação do sistema quando a fila termina ou para por erro.", "Shows a system notification when the queue finishes or stops on an error."); },
        default: true,
    },
    newQuestNotifications: {
        type: OptionType.BOOLEAN,
        get description() { return t("Avisa quando aparece uma missão nova.", "Notifies you when a new quest shows up."); },
        default: true,
    },
    autoUpdate: {
        type: OptionType.BOOLEAN,
        get description() { return t("Baixa as atualizações do plugin pelo GitHub (precisa ter instalado com git clone).", "Downloads plugin updates from GitHub (requires installing with git clone)."); },
        default: true,
    },
    seenQuests: {
        type: OptionType.CUSTOM,
        default: { ready: false, ids: [] as string[] },
        description: "",
    },
    dailyLimit: {
        type: OptionType.NUMBER,
        get description() { return t("Máximo de missões feitas por dia. 0 deixa sem limite.", "Maximum quests per day. 0 means no limit."); },
        default: 0,
    },
    rewardFilter: {
        type: OptionType.CUSTOM,
        default: [] as string[],
        description: "",
    },
    ignoredQuests: {
        type: OptionType.CUSTOM,
        default: [] as string[],
        description: "",
    },
    dailyCount: {
        type: OptionType.CUSTOM,
        default: { day: "", count: 0 },
        description: "",
    },
    panelPosition: {
        type: OptionType.CUSTOM,
        default: { x: -1, y: -1 },
        description: "",
    },
});
