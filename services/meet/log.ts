// 로그: 상태 변화와 지연 시간만 남긴다. 받아 적은 문장, 참석자 이름, 회의 코드 전체는 절대 넘기지 않는다.
export function log(msg: string): void {
  process.stderr.write(`[mosi/meet] ${new Date().toISOString().slice(11, 23)} ${msg}\n`);
}
