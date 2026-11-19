import { useEffect, useRef } from "react";
import { loadConnections, useConnections } from "../../../api/store";
import { Button } from "../../../ui/Button";
import { useSkillSheet } from "./SkillAccounts";

/**
 * 나의 모시 › 할 수 있는 일: a skill that runs with one of the owner's k-skill logins (SkillInfo.connection, e.g. "popbill")
 * shows 연결하기 under its line until that login is connected: accent text, 44 px tall to tap, so the row keeps one
 * column and the switch stays alone at the end (design-director, skill-ui-11 c). It opens the same connect sheet as the
 * connections screen, over the skills screen. The state is live from the connections store, so the row flips the moment
 * the sheet connects (`configured` from GET /api/skills is only the fallback until the store has loaded).
 */
export function SkillConnectButton({ service, name, configured }: { service: string; name: string; configured: boolean }) {
  const { connections, loaded, loading } = useConnections();
  const { open, sheet } = useSkillSheet();
  const anchor = useRef<HTMLSpanElement>(null);
  const tried = useRef(false);
  useEffect(() => {
    if (loaded || loading || tried.current) return;
    tried.current = true;
    void loadConnections();
  }, [loaded, loading]);

  const c = connections.find((x) => x.provider === service);
  const connected = loaded ? c?.status === "connected" : configured;
  // stays mounted while its sheet is open, so the sheet can settle back onto it; gone once it closes connected
  if (connected && !sheet) return null;
  const label = c?.status === "error" ? "다시 연결" : "연결하기";
  return (
    <>
      <span ref={anchor} className="sk-connect">
        <Button variant="plain" size="md" ariaLabel={`${name} ${label}`} disabled={connected} onClick={() => open(service, anchor.current)}>
          {connected ? "연결됨" : label}
        </Button>
      </span>
      {sheet}
    </>
  );
}
