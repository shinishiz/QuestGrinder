/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 chess
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LocaleStore } from "@webpack/common";

// Português por padrão; inglês quando o Discord está em qualquer outro idioma.
export function isEnglish(): boolean {
    const locale: string | undefined = LocaleStore?.locale;
    return !!locale && !locale.startsWith("pt");
}

export const t = (pt: string, en: string) => isEnglish() ? en : pt;

export const joinList = (items: string[]) =>
    new Intl.ListFormat(isEnglish() ? "en" : "pt-BR", { type: "conjunction" }).format(items);
