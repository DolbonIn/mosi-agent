// Chrome 띄우기·닫기 도우미.
// 2026-11-12 18:26~18:39Z: 이 Mac에서 새로 띄운 Chrome이 외부 TCP에 전혀 붙지 못하는 동안(DNS는 됨, curl은 됨) 회의 페이지 goto가
// 두 번 실패했고, 그 뒤 ctx.close()가 90초 동안 멈춰 세션이 끝나지 않았다. 그래서 goto는 짧게 끊어 다시 시도하고,
// 닫기는 5초를 넘기면 우리가 띄운 Chrome 프로세스를 직접 죽인다.
import { chromium, type BrowserContext } from "playwright";

export type LaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

export interface BrowserOps {
  launch(dir: string, opts: LaunchOptions): Promise<BrowserContext>;
  /** 방금 띄운 Chrome 본 프로세스의 pid(이 프로세스의 자식이고 이 프로필을 쓰는 것). 모르면 null */
  findPid(dir: string): Promise<number | null>;
  /** pid(Playwright는 Chrome을 프로세스 그룹 우두머리로 띄우므로 그 그룹째)를 SIGKILL하고 사라질 때까지 잠깐 기다린다 */
  kill(pid: number): Promise<boolean>;
}

/** ps에서 `ppid == parentPid`이고 `--user-data-dir=<dir>`로 뜬 Chrome 본 프로세스(`--type=`이 없는 것)를 찾는다 */
export async function findChromePid(dir: string, parentPid = process.pid): Promise<number | null> {
  try {
    const p = Bun.spawn(["ps", "-axww", "-o", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m || Number(m[2]) !== parentPid) continue;
      const cmd = m[3]!;
      const arg = `--user-data-dir=${dir}`;
      // 인자 경계까지 맞춘다(meet-chrome과 meet-chrome-test를 헷갈리지 않게)
      if ((cmd.endsWith(arg) || cmd.includes(`${arg} `)) && !/\s--type=/.test(cmd)) return Number(m[1]);
    }
  } catch {
    /* ps가 없거나 실패: 모른다 */
  }
  return null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killTree(pid: number, waitMs = 3000): Promise<boolean> {
  try {
    process.kill(-pid, "SIGKILL"); // 그룹째(렌더러·GPU·네트워크 도우미까지)
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return !alive(pid);
    }
  }
  for (const t = Date.now(); Date.now() - t < waitMs; await Bun.sleep(50)) if (!alive(pid)) return true;
  return !alive(pid);
}

export const realBrowserOps: BrowserOps = {
  launch: (dir, opts) => chromium.launchPersistentContext(dir, opts),
  findPid: (dir) => findChromePid(dir),
  kill: (pid) => killTree(pid),
};

export type CloseResult = "closed" | "forced" | "forced_no_pid";

/** ctx.close()를 timeoutMs까지만 기다리고, 넘기면 Chrome 프로세스를 죽인다. 세션이 닫기에 묶이지 않는다 */
export async function closeBounded(ctx: BrowserContext, pid: () => Promise<number | null>, ops: Pick<BrowserOps, "kill">, timeoutMs: number): Promise<CloseResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    ctx.close().then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => (timer = setTimeout(() => r(false), timeoutMs))),
  ]);
  clearTimeout(timer);
  if (closed) return "closed";
  const id = await pid().catch(() => null);
  if (id === null) return "forced_no_pid";
  await ops.kill(id).catch(() => false);
  return "forced";
}

export interface GotoFailure {
  /** 오류 종류(TimeoutError, Error …). 메시지는 URL·회의 코드를 담고 있어 남기지 않는다 */
  name: string;
  /** Chrome 망 오류 코드(net::ERR_… 의 ERR_… 부분)만 */
  net: string | null;
  /** commit: 서버 응답 전(연결이 안 됨) / load: 응답은 왔는데 DOM이 늦음 */
  stage: "commit" | "load";
  /** 망 문제로 보이는지(시간 초과, 연결·이름·인터넷 오류) */
  network: boolean;
  ms: number;
}

const NETWORK_NET_ERR = /^ERR_(CONNECTION|NAME|INTERNET|TIMED_OUT|NETWORK|ADDRESS|PROXY|TUNNEL|EMPTY_RESPONSE|SOCKET)/;

export function gotoFailure(e: unknown, stage: GotoFailure["stage"], ms: number): GotoFailure {
  const rawName = e instanceof Error ? e.name : "Error";
  const name = /^[A-Za-z]{1,40}$/.test(rawName) ? rawName : "Error";
  const msg = e instanceof Error ? e.message : String(e);
  const net = msg.match(/net::(ERR_[A-Z_]+)/)?.[1] ?? null;
  const network = name === "TimeoutError" || (net !== null && NETWORK_NET_ERR.test(net));
  return { name, net, stage, network, ms };
}
