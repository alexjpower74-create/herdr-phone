import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { RPC } from "./core";
import { Failure, invalid } from "./security";

export function target(machine: string) {
  return machine === "local" ? {} : { on: machine };
}
export async function configuredPrograms(core: RPC, machine = "local") {
  let text: string;
  if (machine === "local") {
    text = await readFile(
      process.env.HERDR_PHONE_PROGRAMS ||
        join(homedir(), ".config/herdr-app/programs.json"),
      "utf8",
    );
  } else {
    const override = JSON.parse(
      process.env.HERDR_PHONE_REMOTE_PROGRAMS || "{}",
    )[machine];
    const file = await core.call("file.read", {
      on: machine,
      path: override || ".config/herdr-app/programs.json",
    });
    text = file.text;
  }
  const source = JSON.parse(text);
  return Object.entries(source.programs || {})
    .filter(
      ([, v]: any) =>
        Array.isArray(v.run) &&
        v.run.length > 0 &&
        v.run.every(
          (a: any) =>
            typeof a === "string" && a.length > 0 && !a.includes("\0"),
        ),
    )
    .map(([id, v]: any) => ({
      id,
      name: v.name || id,
      argv: v.run as string[],
    }));
}
export async function createSpace(core: RPC, input: any) {
  const { machineId, programId, cwd } = input;
  if (
    typeof machineId !== "string" ||
    typeof programId !== "string" ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.trim().length > 64 ||
    /[\p{Cc}\p{Cs}]/u.test(input.name) ||
    typeof cwd !== "string" ||
    !cwd ||
    cwd.length > 4096 ||
    /[\p{Cc}\p{Cs}]/u.test(cwd)
  )
    throw invalid();
  if (machineId !== "local") {
    const listing = await core.call("machine.list");
    const machine = listing.machines.find(
      (m: any) => m.name === machineId && !m.temporary,
    );
    if (!machine) throw invalid();
    if (machine.state !== "connected")
      throw new Failure(409, "machine_offline", "The machine is offline.");
  }
  const program = (await configuredPrograms(core, machineId)).find(
    (p) => p.id === programId,
  );
  if (!program) throw invalid();
  // Resolve on the target machine without accepting a command line from the phone.
  const check = await core.call("machine.exec", {
    ...target(machineId),
    cwd,
    argv: ["pwd", "-P"],
    timeout: 1,
  });
  if (check.code !== 0 || check.timed_out) throw invalid();
  const folder = Buffer.from(check.stdout, "base64").toString().trim();
  if (!folder.startsWith("/")) throw invalid();
  const spaceId = `sp${randomUUID().replaceAll("-", "")}`;
  const tabId = `tab${randomUUID().replaceAll("-", "")}`;
  const created = await core.call("terminal.run", {
    ...target(machineId),
    cwd: folder,
    argv: program.argv,
    labels: { "herdr.space": spaceId, "herdr.tab": tabId },
    no_parent: true,
    no_notify: true,
  });
  const address =
    machineId === "local" || created.address.includes("/")
      ? created.address
      : `${machineId}/${created.address}`;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const doc = await core.call("doc.get", {
        name: "herdr-app",
        ...target(machineId),
      });
      const value = structuredClone(doc.value || {});
      value.spaces ||= [];
      let space = value.spaces.find((s: any) => s.id === spaceId);
      if (!space) {
        space = { id: spaceId, folder, tabs: [] };
        value.spaces.push(space);
      }
      space.name = input.name.trim();
      space.folder = folder;
      space.tabs ||= [];
      let tab = space.tabs.find((t: any) => t.id === tabId);
      if (!tab) {
        tab = {
          id: tabId,
          root: {
            id: tabId,
            type: "row",
            children: [
              {
                id: `p${randomUUID().replaceAll("-", "")}`,
                type: "block",
                content: { terminal: created.address.split("/").at(-1) },
              },
            ],
          },
        };
        space.tabs.push(tab);
      }
      tab.name = program.name;
      try {
        await core.call("doc.set", {
          name: "herdr-app",
          ...target(machineId),
          version: doc.version,
          value,
        });
        const qualify = (id: string) =>
          machineId === "local" ? id : `${machineId}/${id}`;
        return {
          spaceId: qualify(spaceId),
          tabId: qualify(tabId),
          terminalId: address,
        };
      } catch (e: any) {
        if (!["conflict", "version_conflict"].includes(e.kind) || attempt === 4)
          throw e;
      }
    }
    throw new Error("Layout conflict");
  } catch (error) {
    await core.call("terminal.kill", { terminal: address }).catch(() => {});
    await core.call("terminal.rm", { terminal: address }).catch(() => {});
    throw error;
  }
}
