import type { Connection } from "@pickle/protocol";
import type { ReactNode } from "react";
import { BrandIcon } from "../../../assets/brands/BrandIcon";
import { Button } from "../../../ui/Button";
import { R } from "../../../ui/geometry";
import { Icon } from "../../../ui/Icon";
import { useSecondTicker } from "../format";
import { InlineError, Lead, Note } from "../parts";
import { mmss, useLoginRelay } from "./useLoginRelay";
import "./RelayLogin.css";

/**
 * "디스코드 로그인" inside the connect sheet, through Discord's own QR login (remote auth). No password, no token:
 *
 *   intro          what happens → "로그인 시작"
 *   waiting_scan   primary: "디스코드 앱에서 로그인 승인", with the ToS caution as one sentence right above it (the moment
 *                  the person approves) — a real link to https://discord.com/ra/… (Discord registers
 *                  /ra/* as an app link, so on this phone it opens the Discord app); below it the same link as a QR
 *                  code for a computer or another phone, and the real time left
 *   waiting_confirm the Discord app scanned it and shows who: "앱에서 '로그인'을 눌러 주세요"
 *   expired / cancelled / error → the reason + "새 QR 코드 만들기" / "다시 시도"
 *   → connected: handed back to ConnectSheet (its pill morphs to 연결됨 and the example prompts appear)
 *
 * The app polls while it waits, at once when it comes back from the Discord app. Closing the sheet cancels the relay.
 */

export interface RelayLoginView {
  busy: boolean;
  /** for the sheet's live pill */
  status: "connecting" | "needs_verification" | "error" | undefined;
  body: ReactNode;
  footer: ReactNode;
}

export function useDiscordLogin({
  userId,
  enabled,
  intro,
  onConnected,
}: {
  userId: string | null;
  enabled: boolean;
  intro?: ReactNode;
  onConnected: (c: Connection) => void;
}): RelayLoginView {
  const relay = useLoginRelay({ provider: "discord", userId, enabled, onConnected });
  const { live, ended, busy, error } = relay;
  const now = useSecondTicker(enabled && !!live);
  const left = live ? live.expiresAt - now : 0;

  const begin = () => void relay.start("QR 코드 만드는 중");

  let body: ReactNode;
  let footer: ReactNode;

  if (live?.state === "waiting_scan" && live.qrUrl) {
    body = (
      <div className="more-sheet-group rl-discord">
        <Lead>아래 버튼을 누르면 디스코드 앱이 열려요. 앱에 뜨는 화면에서 &lsquo;로그인&rsquo;을 누르면 바로 연결돼요.</Lead>
        <ol className="rl-steps">
          <li>
            <span className="rl-steps__n tnum">1</span>
            <span>디스코드 앱에서 로그인 승인을 눌러요</span>
          </li>
          <li>
            <span className="rl-steps__n tnum">2</span>
            <span>앱에 뜬 계정이 맞는지 보고 &lsquo;로그인&rsquo;을 눌러요</span>
          </li>
        </ol>
        {live.qrSvg && (
          <figure className="rl-qr">
            <img src={live.qrSvg} alt="디스코드 로그인 QR 코드" width={168} height={168} draggable={false} />
            <figcaption>컴퓨터나 다른 휴대폰이면 디스코드 앱의 &lsquo;QR 코드 스캔&rsquo;으로 찍어 주세요</figcaption>
          </figure>
        )}
        <p className="rl-timer tnum" aria-live="off">
          <Icon name="clock" size={15} weight="medium" />
          <span>{left > 0 ? `${mmss(left)} 안에 승인해 주세요` : "시간이 거의 다 됐어요"}</span>
        </p>
      </div>
    );
    footer = (
      <div className="conn-footer rl-footer">
        <p className="rl-terms">디스코드는 개인 계정 자동화를 이용약관으로 막고 있어서, 드물게 계정이 제한될 수 있어요.</p>
        <a className="btn btn-full rl-applink" data-tone="primary" data-size="lg" data-state="idle" href={live.qrUrl} target="_blank" rel="noopener noreferrer">
          <span className="btn-label">
            <BrandIcon provider="discord" size={22} radius={R.plate} />
            <span>디스코드 앱에서 로그인 승인</span>
          </span>
        </a>
        <button type="button" className="rl-link" onClick={relay.reset}>
          취소
        </button>
      </div>
    );
  } else if (live?.state === "waiting_confirm") {
    body = (
      <div className="more-sheet-group rl-discord">
        <div className="rl-confirm" role="status">
          <span className="rl-confirm__spin" aria-hidden="true" />
          <div>
            <p className="rl-confirm__title">{live.account?.name ? `${live.account.name} 계정으로 로그인하려고 해요` : "디스코드 앱에서 확인했어요"}</p>
            <p className="rl-confirm__sub">디스코드 앱에서 &lsquo;로그인&rsquo;을 눌러 주세요. 누르면 바로 연결돼요.</p>
          </div>
        </div>
        <Note icon="shield">내 계정이 아니면 앱에서 &lsquo;취소&rsquo;를 눌러 주세요.</Note>
      </div>
    );
    footer = (
      <div className="conn-footer rl-footer">
        <InlineError>{error?.message}</InlineError>
        <button type="button" className="rl-link" onClick={relay.reset}>
          취소
        </button>
      </div>
    );
  } else {
    // intro, or the end of a previous attempt
    const reason = ended?.error?.message ?? error?.message ?? null;
    const expired = ended?.state === "expired" || ended?.error?.code === "timeout";
    body = (
      <>
        <Lead>디스코드 앱에서 &lsquo;로그인&rsquo;만 누르면 연결돼요. 비밀번호나 토큰은 입력하지 않아요.</Lead>
        {intro}
        <Note icon="lock">보안 금고에는 연결 정보만 보관해요. 모시가 디스코드 비밀번호를 보거나 저장하는 일은 없어요.</Note>
      </>
    );
    footer = (
      <div className="conn-footer rl-footer">
        <InlineError>{reason}</InlineError>
        <Button fullWidth state={busy ? "loading" : "idle"} busyLabel={busy ?? undefined} onClick={begin}>
          {expired ? "새 QR 코드 만들기" : ended || error ? "다시 시도" : "로그인 시작"}
        </Button>
      </div>
    );
  }

  const status: RelayLoginView["status"] = busy ? "connecting" : live ? "needs_verification" : ended?.state === "error" || error ? "error" : undefined;
  return { busy: !!busy, status, body, footer };
}
