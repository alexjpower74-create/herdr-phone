export type SelectedFile = { key: string; file: File; preview?: string };
export type Draft = { text: string; revision: number; files: SelectedFile[] };
export const drafts = new Map<string, Draft>();
export function draft(id: string): Draft {
  if (!drafts.has(id)) drafts.set(id, { text: "", revision: 0, files: [] });
  return drafts.get(id)!;
}
export function selectFiles(saved: Draft, files: File[]) {
  if (saved.files.length + files.length > 8) return "Choose up to eight files per message.";
  if (files.some(file => file.size > 20 * 1024 * 1024)) return "Each file must be 20 MiB or smaller.";
  saved.files.push(...files.map(file => ({ key: crypto.randomUUID(), file })));
  saved.revision++;
}
export function preview(selected: SelectedFile) {
  if (!selected.preview && selected.file.type.startsWith("image/") && !/hei[cf]/i.test(selected.file.type))
    selected.preview = URL.createObjectURL(selected.file);
  return selected.preview;
}
export function removeFile(saved: Draft, key: string) {
  const selected = saved.files.find(file => file.key === key);
  if (selected?.preview) URL.revokeObjectURL(selected.preview);
  saved.files = saved.files.filter(file => file.key !== key);
  saved.revision++;
}
export function clearDraft(saved: Draft) {
  for (const file of saved.files) if (file.preview) URL.revokeObjectURL(file.preview);
  saved.text = "";
  saved.files = [];
  saved.revision++;
}
export function releasePreviews() {
  for (const saved of drafts.values()) for (const file of saved.files) {
    if (file.preview) URL.revokeObjectURL(file.preview);
    file.preview = undefined;
  }
}
export function forgetDrafts() {
  releasePreviews();
  drafts.clear();
}
