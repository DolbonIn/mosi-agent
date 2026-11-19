import type { EnclaveInfo } from "@pickle/protocol";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useId, useState } from "react";
import { toApiError } from "../../../api/client";
import * as ep from "../../../api/endpoints";
import { nav } from "../../../app/nav";
import { EXIT, SPRING } from "../../../motion/springs";
import { useTierValue } from "../../../motion/tier";
import { Icon, type AppIconName } from "../../../ui/Icon";
import { presentSheet, type SheetApi, type SheetSource } from "../../../ui/Sheet";
import { josa } from "../format";
import { copyOf, InlineError, Note, SectionLabel, useAgentName } from "../parts";

/**
 * Privacy explainer (MOTION-SPEC §6.6, research 6-6, HIG privacy, my-mosi B): three plain answers — what is kept,
 * who can see it, how to erase it — each shortcut as a text link under the answer that names it (접근 기록 보기,
 * 저장된 로그인 보기); the sheet ends on "자세히 보기", which opens in place: how a password is sealed on this device
 * for the Credential Enclave, with the enclave's real key id and measurement from GET /api/enclave.
 */
export function presentPrivacy(source: SheetSource) {
  return presentSheet({ source, title: "개인 정보 보호", render: (api) => <PrivacyBody api={api} /> });
}

function PrivacyBody({ api }: { api: SheetApi }) {
  const agentName = useAgentName();
  const reduce = useTierValue("reduceMotion");
  const [more, setMore] = useState(false);
  const [info, setInfo] = useState<EnclaveInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const detailsId = useId();

  useEffect(() => {
    ep.enclave()
      .then(setInfo)
      .catch((e) => setError(toApiError(e).message));
  }, []);

  const go = (screen: string, title: string, params?: Record<string, unknown>) => {
    api.close();
    nav.push(screen, params, { title });
  };

  // the questions are the headings (GR-R1): no tiles beside them; a shortcut sits under the answer that names it
  const lines: { title: string; body: string; link?: { label: string; open: () => void } }[] = [
    { title: "무엇을 보관하나요", body: `대화, ${josa(agentName, "이가")} 기억한 내용, 연결한 서비스의 로그인 정보예요. 로그인 정보는 이 기기에서 암호화된 채로만 보관돼요.` },
    {
      title: "누가 볼 수 있나요",
      body: `나만 볼 수 있어요. ${josa(agentName, "은는")} 로그인 정보의 원문을 보지 못하고, 쓸 때마다 접근 기록에 남아요.`,
      link: { label: "접근 기록 보기", open: () => go("vault", "접근 기록", { segment: "log" }) },
    },
    {
      title: "어떻게 지우나요",
      body: "저장된 로그인, 기억, 연결은 언제든 하나씩 지울 수 있어요. 보관 기간이 지나면 저절로 지워져요.",
      link: { label: "저장된 로그인 보기", open: () => go("vault", "저장된 로그인", { segment: "logins" }) },
    },
  ];

  return (
    <div className="more-sheet privacy-body">
      <ul className="privacy-lines">
        {lines.map((l) => (
          <li key={l.title} className="privacy-line">
            <h3 className="privacy-line__title">{l.title}</h3>
            <p className="privacy-line__body t-copy">{copyOf(l.body)}</p>
            {l.link && (
              <button type="button" className="privacy-link" onClick={l.link.open}>
                {l.link.label}
              </button>
            )}
          </li>
        ))}
      </ul>

      <button type="button" className="privacy-more" aria-expanded={more} aria-controls={detailsId} onClick={() => setMore((v) => !v)}>
        <span className="t-copy">암호화가 어떻게 되는지 자세히 보기</span>
        <motion.span animate={{ rotate: more ? 180 : 0 }} transition={reduce ? { duration: 0 } : SPRING.snap} className="privacy-more__chev" aria-hidden="true">
          <Icon name="chevron-down" size={16} weight="semibold" />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {more && (
          <motion.div
            id={detailsId}
            key="details"
            className="privacy-details"
            initial={reduce ? false : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0, transition: SPRING.morph }}
            exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -6, transition: EXIT }}
          >
            <SectionLabel level={3}>비밀번호가 보관되는 길</SectionLabel>
            <ol className="seal-flow" aria-label="암호화 과정">
              <SealStep icon="person" title="이 기기" body="입력한 비밀번호를 기기 안에서 바로 봉투에 담아 잠가요 (ECDH P-256 · AES-256-GCM)." />
              <SealStep icon="lock" title="잠긴 봉투" body="봉투에는 내 계정과 서비스 이름이 함께 묶여 있어 다른 곳에서는 열 수 없어요." />
              <SealStep icon="shield" title="보안 금고 (Credential Enclave)" body="봉투는 금고 안에서만 열려요. 서버 운영자도 원문을 볼 수 없어요." />
              <SealStep icon="key" title={`${josa(agentName, "이가")} 쓸 때`} body="로그인할 때만 금고가 대신 써 주고, 언제 무엇에 썼는지 접근 기록에 남겨요." last />
            </ol>

            <SectionLabel level={3}>금고 확인 정보</SectionLabel>
            <div className="more-sheet-rows">
              <div className="more-sheet-row">
                <span className="more-sheet-row__main">
                  <span className="more-sheet-row__sub">측정값 (금고 코드의 SHA-256)</span>
                  <code className="privacy-hash" data-measurement={info?.measurement ?? ""}>
                    {info ? info.measurement : error ? "불러오지 못했어요" : "불러오는 중이에요"}
                  </code>
                </span>
              </div>
              <div className="more-sheet-row">
                <span className="more-sheet-row__main">
                  <span className="more-sheet-row__sub">키 ID · 방식</span>
                  <code className="privacy-hash">{info ? `${info.kid} · ${info.alg}` : "—"}</code>
                </span>
              </div>
            </div>
            <InlineError>{error}</InlineError>
            <Note icon="info">측정값은 공개된 금고 코드에서 누구나 다시 계산해 볼 수 있어요. 값이 바뀌면 코드가 바뀐 거예요.</Note>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}

function SealStep({ icon, title, body, last }: { icon: AppIconName; title: string; body: string; last?: boolean }) {
  return (
    <li className="seal-step" data-last={last || undefined}>
      <span className="seal-step__rail" aria-hidden="true">
        <span className="seal-step__dot">
          <Icon name={icon} size={16} weight="medium" />
        </span>
      </span>
      <span className="seal-step__main">
        <span className="seal-step__title">{title}</span>
        <span className="seal-step__body">{body}</span>
      </span>
    </li>
  );
}
