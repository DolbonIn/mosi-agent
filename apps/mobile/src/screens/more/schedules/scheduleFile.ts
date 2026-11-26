import type { Schedule } from "@pickle/protocol";

/**
 * A schedule's attached text file, as the list and its sheet say it (DD 2014, agent-runtime 2037). The row's third
 * line gives the reason, never "꺼짐" again (the switch says that). A schedule whose file was deleted and that is off
 * cannot be switched on: the server answers 409 schedule_file_deleted, so the switch is disabled and its name says
 * why. The way back is a new upload and a new schedule (PATCH never changes the file).
 */

/** the row's third line: the file's name, or what happened to it; null with no file */
export function fileLine(s: Pick<Schedule, "file" | "enabled">): string | null {
  if (!s.file) return null;
  if (!s.file.deleted) return s.file.name || null;
  return s.enabled ? "파일을 지웠어요" : "파일을 지워서 꺼졌어요";
}

/** off for good: its file was deleted and it is off, whoever switched it off (the run that told, or the person) */
export const fileLocked = (s: Pick<Schedule, "file" | "enabled">): boolean => !!s.file?.deleted && !s.enabled;

/** the switch's name: what it does, or why it does nothing */
export const toggleLabel = (s: Pick<Schedule, "title" | "file" | "enabled">): string =>
  fileLocked(s) ? `${s.title}, 파일을 지워서 켤 수 없어요` : `${s.title} 켜기`;

/** the sheet's 지시 파일 fact; null with no file */
export const fileFact = (s: Pick<Schedule, "file">): string | null => (s.file ? (s.file.deleted ? "지웠어요" : s.file.name) : null);

/** under the facts of a schedule that is off for good */
export const FILE_AGAIN = "파일을 다시 올리고 예약을 새로 만들면 다시 할 수 있어요.";
