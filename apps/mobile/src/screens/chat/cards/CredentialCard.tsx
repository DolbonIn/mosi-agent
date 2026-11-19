import type { CredentialRequestCard, KeepFor } from "@pickle/protocol";
import { useEffect, useState } from "react";
import * as ep from "../../../api/endpoints";
import { connectionsStore, sessionStore, useAgent } from "../../../api/store";
import { BrandIcon, hasBrandIcon } from "../../../assets/brands/BrandIcon";
import { ContentSwap } from "../../../motion/ContentSwap";
import { Button } from "../../../ui/Button";
import { Icon } from "../../../ui/Icon";
import { List, ListRow } from "../../../ui/List";
import { presentSheet } from "../../../ui/Sheet";
import { TextField } from "../../../ui/TextField";
import { josa, KEEP_FOR, keepForLabel } from "../util";
import { sealKindOf } from "./sealKind";

/**
 * Credential request (MOTION-SPEC §6.2, research §3-5, chat B): an inline secure form built from the card's `fields`,
 * as ONE grouped field (labels leading, an inset hairline between). The secret is sealed ON THIS DEVICE for the
 * Credential Enclave (sealCredential → POST /api/credentials) — the server and the model never see it. The promise is
 * said once, under the password ("이 기기에서 암호화돼요. 깽이도 볼 수 없어요."); the agent's line above the card says
 * why. Keep-for is a sentence with a default (7일), changed from a menu that grows out of "바꾸기". "저장하고 이어서
 * 하기" saves (loader → check, only on the server's 201), the card morphs into "저장됨 · 7일", and the reply the old
 * "이어서 해 줘" chip sent goes out at once (the save itself still needs the person's tap). A missing value is that
 * field's error. Leaving the app masks every value at once (visibilitychange).
 */
const savedFor = new Map<string, KeepFor>();
const cardKeyOf = (c: CredentialRequestCard, msgId: string) => `${msgId}:${c.service}`;
const keepSentence = (k: KeepFor) => (k === "forever" ? "계속 보관해요" : `${keepForLabel(k)} 동안 보관해요`);

export function CredentialCard({ card, messageId, onSend, interactive }: { card: CredentialRequestCard; messageId: string; onSend: (text: string) => void; interactive: boolean }) {
  const key = cardKeyOf(card, messageId);
  const agentName = useAgent()?.name ?? "깽이";
  const [values, setValues] = useState<Record<string, string>>({});
  const [keepFor, setKeepFor] = useState<KeepFor>("7d");
  const [fieldError, setFieldError] = useState<{ key: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<KeepFor | null>(() => savedFor.get(key) ?? null);
  const [veiled, setVeiled] = useState(false);

  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        setVeiled(true);
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const status = saved ? "saved" : card.status;
  const missing = card.fields.filter((f) => !values[f.key]?.trim());
  // the promise sits under the secret: the password field, else the last one
  const hintKey = (card.fields.find((f) => f.type === "password") ?? card.fields[card.fields.length - 1])?.key;

  // a missing value is that field's error, said before the button starts its work (it never shows 다시 시도하기)
  const flagMissing = (): boolean => {
    const f = missing[0];
    if (!f) return false;
    setFieldError({ key: f.key, message: `${josa(f.label, "을", "를")} 입력해 주세요` });
    return true;
  };

  const save = async () => {
    setError(null);
    setFieldError(null);
    if (flagMissing()) throw new Error("missing");
    const userId = sessionStore.get().session?.user.id;
    if (!userId) throw new Error("다시 로그인해 주세요");
    const provider = connectionsStore.get().providers.find((p) => p.id === card.service);
    const kind = sealKindOf(provider, card.fields);
    try {
      await ep.saveCredentialSealed({ userId, service: card.service, label: card.serviceName, kind, keepFor, fields: values });
    } catch (e) {
      const msg = (e as Error).message || "저장하지 못했어요";
      setError(msg);
      throw e;
    }
    // the server took it (201): the reply goes out now, not after the check has been shown — the server's own update
    // can flip this card to its saved state first, and that unmounts the button (and its onSuccess) on the way
    savedFor.set(key, keepFor);
    onSend(`${card.serviceName} 로그인 정보를 저장했어요. 이어서 해 줘`);
  };

  const chooseKeep = (source: HTMLElement) =>
    presentSheet({
      source,
      title: "보관 기간",
      render: (api) => (
        <List label="보관 기간">
          {KEEP_FOR.map((o) => (
            <ListRow
              key={o.value}
              title={o.value === "forever" ? "계속 보관" : `${o.label} 동안`}
              detail={o.value === keepFor ? <Icon name="checkmark" size={18} weight="semibold" /> : undefined}
              chevron={false}
              ariaLabel={`${o.value === "forever" ? "계속 보관" : `${o.label} 동안`}${o.value === keepFor ? ", 선택됨" : ""}`}
              onClick={() => {
                setKeepFor(o.value);
                api.close();
              }}
            />
          ))}
        </List>
      ),
    });

  if (status !== "pending") {
    const k = saved ?? savedFor.get(key);
    return (
      <section className="ccard ccard-cred is-done" aria-label={`${card.serviceName} 로그인 정보`}>
        <span className="cred-pill" data-status={status}>
          <Icon name={status === "saved" ? "lock" : "close"} size={15} weight="medium" />
          {status === "saved" ? (k ? `저장됨 · ${keepForLabel(k)}` : "저장됨") : "건너뛰었어요"}
        </span>
      </section>
    );
  }

  return (
    <section className="ccard ccard-cred" aria-label={`${card.serviceName} 로그인 정보 입력`} data-veiled={veiled || undefined}>
      <div className="ccard-head">
        {hasBrandIcon(card.service) && <BrandIcon provider={card.service} size={22} radius={6} />}
        <h3 className="ccard-title">{card.serviceName} 로그인</h3>
      </div>
      <form
        className="cred-form"
        autoComplete="on"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <div className="cred-group">
          {card.fields.map((f) => (
            <TextField
              key={f.key}
              label={f.label}
              type={veiled ? "password" : f.type}
              variant="filled"
              name={`${card.service}-${f.key}`}
              autoComplete={f.autocomplete ?? (f.type === "password" ? "current-password" : f.key === "otp" ? "one-time-code" : "username")}
              placeholder={f.placeholder}
              value={values[f.key] ?? ""}
              disabled={!interactive}
              error={fieldError?.key === f.key ? fieldError.message : undefined}
              hint={f.key === hintKey ? `이 기기에서 암호화돼요. ${agentName}도 볼 수 없어요.` : undefined}
              onFocus={() => setVeiled(false)}
              onChange={(v) => {
                setValues((s) => ({ ...s, [f.key]: v }));
                if (fieldError?.key === f.key) setFieldError(null);
                setError(null);
              }}
            />
          ))}
        </div>
        <div className="cred-keep">
          <p className="cred-keep-label">{keepSentence(keepFor)}</p>
          <button type="button" className="cred-keep-change" aria-haspopup="dialog" disabled={!interactive} aria-label={`보관 기간 바꾸기, 지금 ${keepForLabel(keepFor)}`} onClick={(e) => chooseKeep(e.currentTarget)}>
            바꾸기
            <Icon name="chevron-down" size={14} weight="semibold" />
          </button>
        </div>
        <ContentSwap swapKey="save" display="block">
          <Button
            fullWidth
            size="md"
            tone="primary"
            disabled={!interactive}
            busyLabel="기기에서 암호화하는 중"
            successLabel="저장했어요"
            onClick={(e) => {
              if (flagMissing()) e.preventDefault();
            }}
            action={save}
            onSuccess={() => {
              setSaved(keepFor);
              setValues({});
            }}
          >
            저장하고 이어서 하기
          </Button>
        </ContentSwap>
      </form>
      {error && (
        <p className="ccard-error" role="alert">
          <Icon name="exclamation" size={15} weight="medium" /> {error}
        </p>
      )}
    </section>
  );
}
