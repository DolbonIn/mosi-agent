import { useIsland } from "./island";

/**
 * The screen-reader twin of the agent state (MOTION-SPEC §8.3): one polite live region fed by the shared store
 * (`announce` changes only when worth saying — "생각하는 중" after 1 s, the tool label, "승인이 필요해요: …",
 * "완료했어요", errors, stalls; never the elapsed seconds or the call timer). Mounted once in the Shell.
 */
export function AgentLive() {
  const announce = useIsland((s) => s.announce);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announce}
    </div>
  );
}
