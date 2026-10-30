/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 chess
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import { relaunch } from "@utils/native";
import type { PluginNative } from "@utils/types";
import { showToast } from "@webpack/common";

import { t } from "./i18n";
import { settings } from "./settings";

const Native = VencordNative.pluginHelpers.QuestGrinder as PluginNative<typeof import("./native")>;
const logger = new Logger("QuestGrinder");

// Puxa o código novo do GitHub. Ele entra no próximo build do Equicord (atualização do Equicord ou "pnpm build");
// a notificação permite aplicar na hora sem esperar.
export async function checkForUpdates() {
    if (IS_WEB || !settings.store.autoUpdate) return;

    const res = await Native.pullUpdates();
    switch (res.status) {
        case "not-git":
        case "up-to-date":
            return;
        case "local-changes":
            logger.info("Tem arquivos editados na pasta do plugin, atualização pulada.");
            return;
        case "error":
            logger.warn("Não consegui atualizar o plugin:", res.message);
            return;
        case "updated": {
            const n = res.commits.length;
            logger.info(`Atualizado (${n}):`, res.commits);
            showNotification({
                title: t("QuestGrinder atualizado", "QuestGrinder updated"),
                body: t(
                    `${n} ${n === 1 ? "mudança baixada" : "mudanças baixadas"}. Clique para aplicar agora, ou ela entra na próxima atualização do Equicord.`,
                    `${n} ${n === 1 ? "change" : "changes"} downloaded. Click to apply now, or it will be applied with the next Equicord update.`
                ),
                permanent: true,
                noPersist: true,
                onClick: applyNow,
            });
        }
    }
}

async function applyNow() {
    showToast({ text: t("QuestGrinder: aplicando a atualização...", "QuestGrinder: applying the update..."), variant: "default" });
    if (await Native.rebuild()) relaunch();
    else showToast({ text: t("QuestGrinder: o build falhou. Rode \"pnpm build\" na pasta do Equicord.", "QuestGrinder: the build failed. Run \"pnpm build\" in the Equicord folder."), variant: "critical" });
}
