// 모시 봇 계정 로그인 창: services/meet가 쓰는 Chrome 프로필(~/.config/pickle-clone/meet-chrome)로 accounts.google.com을 연다.
// 비밀번호는 사용자가 창에 직접 입력한다. 이 스크립트는 아무것도 입력하거나 읽거나 저장하지 않는다.
// 자동화 없이 그냥 Chrome을 띄운다(Playwright로 열면 Google이 "안전하지 않은 브라우저"로 로그인을 막는 일이 있다).
//   bun services/meet/login.ts
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config";

const dir = config.profileDir;
mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);

const chrome = [
  process.env.MEET_CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
].find((p) => p && existsSync(p));
if (!chrome) {
  console.error("Google Chrome을 찾지 못했어요. 설치하거나 MEET_CHROME_PATH를 지정해 주세요.");
  process.exit(1);
}

let locked = false;
try {
  lstatSync(join(dir, "SingletonLock"));
  locked = true;
} catch {
  /* 잠금 없음 */
}
if (locked) {
  console.error("이 프로필을 이미 다른 Chrome이 쓰고 있어요(회의 중인 services/meet 또는 열려 있는 로그인 창).");
  console.error("회의를 끝내거나 그 창을 닫은 뒤 다시 실행해 주세요. 남은 잠금 파일이라면 Chrome 창이 없는지 확인하고 지워도 됩니다.");
  process.exit(1);
}

console.log("모시 봇 계정 로그인 창을 엽니다.");
console.log("  1. 열린 Chrome 창에서 모시용 Google 계정으로 직접 로그인하세요(개인 계정 말고 봇 전용 계정을 권장).");
console.log("  2. 로그인이 끝나면 창을 닫으세요. 그 뒤로 services/meet는 이 계정 이름으로 회의에 참여합니다.");
console.log("  비밀번호는 Chrome 창에만 입력되고, 이 스크립트·로그·모시 서버는 그 값을 보지 않습니다.");
console.log(`  프로필 위치: ${dir.replace(process.env.HOME ?? "", "~")}`);

const p = spawn(chrome, [`--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--lang=ko", "https://accounts.google.com/"], { stdio: "ignore" });
p.on("exit", (code) => {
  console.log(code === 0 ? "창을 닫았어요. 로그아웃하려면 다시 실행해서 계정 메뉴에서 로그아웃하세요." : `Chrome이 코드 ${code}로 끝났어요.`);
  process.exit(0);
});
