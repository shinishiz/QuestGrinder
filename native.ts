/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 chess
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile as cpExecFile } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { promisify } from "util";

const execFile = promisify(cpExecFile);
const isFlatpak = process.platform === "linux" && !!process.env.FLATPAK_ID;

if (process.platform === "darwin") process.env.PATH = `/usr/local/bin:${process.env.PATH}`;

export type UpdateResult =
    | { status: "updated"; commits: string[]; }
    | { status: "up-to-date"; }
    | { status: "not-git"; }
    | { status: "local-changes"; }
    | { status: "error"; message: string; };

function run(cmd: string, args: string[], cwd: string) {
    if (isFlatpak) return execFile("flatpak-spawn", ["--host", cmd, ...args], { cwd });
    return execFile(cmd, args, { cwd });
}

// Sobe a partir da pasta do build (dist/desktop ou dist/equibop) até achar a raiz do Equicord.
function findEquicordRoot() {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, "src", "userplugins")) && existsSync(join(dir, "scripts", "build", "build.mjs"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

// A pasta pode ter qualquer nome, então procura pelo plugin em vez de confiar no nome.
function findPluginDir(root: string) {
    const base = join(root, "src", "userplugins");
    for (const name of readdirSync(base)) {
        const index = join(base, name, "index.tsx");
        if (!existsSync(join(base, name, "questEngine.ts")) || !existsSync(index)) continue;
        if (/name:\s*"QuestGrinder"/.test(readFileSync(index, "utf8"))) return join(base, name);
    }
    return null;
}

export async function pullUpdates(_: unknown): Promise<UpdateResult> {
    try {
        const root = findEquicordRoot();
        const dir = root && findPluginDir(root);
        if (!dir || !existsSync(join(dir, ".git"))) return { status: "not-git" };

        await run("git", ["fetch", "--quiet"], dir);
        const log = await run("git", ["log", "HEAD..@{u}", "--pretty=format:%s"], dir);
        const commits = log.stdout.trim().split("\n").filter(Boolean);
        if (!commits.length) return { status: "up-to-date" };

        const changes = await run("git", ["status", "--porcelain", "--untracked-files=no"], dir);
        if (changes.stdout.trim()) return { status: "local-changes" };

        // Com commits locais que não estão no GitHub, o --ff-only falha sem estragar nada.
        await run("git", ["pull", "--ff-only", "--quiet"], dir);
        return { status: "updated", commits };
    } catch (e) {
        return { status: "error", message: String((e as any)?.stderr || (e as Error)?.message || e).trim() };
    }
}

// Mesmo build que o atualizador do Equicord roda depois de um update.
export async function rebuild(_: unknown): Promise<boolean> {
    const root = findEquicordRoot();
    if (!root) return false;
    const args = ["scripts/build/build.mjs"];
    if (IS_DEV) args.push("--dev");
    try {
        const res = await run("node", args, root);
        return !res.stderr.includes("Build failed");
    } catch {
        return false;
    }
}
