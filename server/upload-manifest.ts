export const MAX_UPLOAD = 20 * 1024 * 1024;
export const UPLOAD_ENVELOPE = 64 * 1024;
export const UPLOAD_LIFETIME = 7 * 86400000;
export type UploadedFile = { id: string; name: string; type: string; size: number; converted: boolean };
export type UploadRecord = UploadedFile & {
  deviceId: string;
  terminalId: string;
  incarnation: string;
  machine: string;
  root: string;
  date: string;
  filename: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "ready";
  digest: string;
};
export function validUploads(value: unknown): value is UploadRecord[] {
  return Array.isArray(value) && value.length <= 16384 && new Set(value.map((r: any) => r?.id)).size === value.length && value.every((r: any) =>
    r && /^[a-f0-9]{48}$/.test(r.id) && typeof r.name === "string" && r.name.length <= 128 &&
    typeof r.deviceId === "string" && typeof r.terminalId === "string" && /^[a-f0-9]{64}$/.test(r.incarnation) &&
    typeof r.machine === "string" && typeof r.root === "string" && /^(\/|~\/)/.test(r.root) &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.date) && new RegExp(`^${r.id}\\.(png|jpg|gif|webp|pdf|txt)$`).test(r.filename) &&
    ["pending", "ready"].includes(r.status) && typeof r.converted === "boolean" && typeof r.type === "string" &&
    Number.isSafeInteger(r.size) && r.size > 0 && r.size <= MAX_UPLOAD && Number.isSafeInteger(r.createdAt) &&
    Number.isSafeInteger(r.expiresAt) && r.expiresAt === r.createdAt + UPLOAD_LIFETIME &&
    (r.status === "pending" ? (r.digest === "" || /^[a-f0-9]{64}$/.test(r.digest)) && r.type === "" :
      /^[a-f0-9]{64}$/.test(r.digest) && ({ png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", txt: "text/plain" } as Record<string, string>)[r.filename.split(".").at(-1)!] === r.type));
}
export function publicUpload(record: UploadedFile): UploadedFile {
  return { id: record.id, name: record.name, type: record.type, size: record.size, converted: record.converted };
}
