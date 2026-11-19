/**
 * A fake libtdjson (TdJson) that walks TDLib's authorization states the way the real library does:
 * WaitTdlibParameters → WaitPhoneNumber → WaitCode → (WaitPassword) → Ready, with per-directory "databases" so a
 * second open of an authorised directory with the right key goes straight to Ready.
 */
import type { TdJson, TdObject } from "../src/tdlib/runtime";

export const TG_PHONE_LOCAL = "010-2345-6789";
export const TG_PHONE_E164 = "+821023456789";
export const TG_CODE = "52817";
export const TG_PASSWORD = "tg-2fa-비밀-hunter3";
export const TG_HINT = "강아지 이름";

export interface FakeTdOptions {
  twoFa?: boolean;
  /** phone (E.164) answered with PHONE_NUMBER_BANNED */
  banned?: string;
  /** setAuthenticationPhoneNumber answers 429 "retry after <n>" */
  floodSeconds?: number;
  /** a code answered with PHONE_CODE_EXPIRED */
  expiredCode?: string;
  /** no account for this number: the code leads to WaitRegistration */
  unregistered?: boolean;
  /** never answer setAuthenticationPhoneNumber (timeouts) */
  stallPhone?: boolean;
  /** logOut answers an error (the session stays authorised) */
  logOutFails?: boolean;
  /** logOut never answers */
  stallLogOut?: boolean;
}

interface Inst {
  state: string;
  dir: string | null;
  key: string | null;
  phone: string | null;
  started: boolean;
}

export class FakeTdJson implements TdJson {
  readonly requests: { clientId: number; query: TdObject }[] = [];
  readonly dbs = new Map<string, { key: string; authorised: boolean }>();
  private readonly queue: string[] = [];
  private readonly waiting: ((v: string | null) => void)[] = [];
  private readonly insts = new Map<number, Inst>();
  private next = 1;
  me = { "@type": "user", id: 777001, first_name: "Alice", last_name: "Kim" };
  chats: { id: number; title: string; type: TdObject; unread?: number }[] = [
    { id: 1001, title: "엄마", type: { "@type": "chatTypePrivate", user_id: 5 }, unread: 2 },
    { id: -2002, title: "스터디 모임", type: { "@type": "chatTypeBasicGroup" } },
  ];
  sent: { chatId: number; text: string }[] = [];
  /** database directories that were logged out (TDLib logOut) */
  readonly loggedOut: string[] = [];
  /** every logOut request, answered or not */
  logOutCalls = 0;

  constructor(public opts: FakeTdOptions = {}) {}

  createClientId(): number {
    const id = this.next++;
    this.insts.set(id, { state: "authorizationStateWaitTdlibParameters", dir: null, key: null, phone: null, started: false });
    return id;
  }

  execute(): string | null {
    return null;
  }

  receive(timeoutSec: number): Promise<string | null> {
    const ev = this.queue.shift();
    if (ev) return Promise.resolve(ev);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const i = this.waiting.indexOf(done);
        if (i >= 0) this.waiting.splice(i, 1);
        resolve(null);
      }, Math.min(timeoutSec * 1000, 50));
      const done = (v: string | null) => {
        clearTimeout(t);
        resolve(v);
      };
      this.waiting.push(done);
    });
  }

  send(clientId: number, request: string): void {
    const q = JSON.parse(request) as TdObject;
    this.requests.push({ clientId, query: q });
    const inst = this.insts.get(clientId);
    if (!inst) return;
    if (!inst.started) {
      inst.started = true;
      this.auth(clientId, inst, inst.state);
    }
    const extra = q["@extra"];
    const ok = (body: TdObject = { "@type": "ok" }) => this.emit({ ...body, "@client_id": clientId, "@extra": extra });
    const err = (code: number, message: string) => this.emit({ "@type": "error", code, message, "@client_id": clientId, "@extra": extra });
    switch (q["@type"]) {
      case "getAuthorizationState":
        return ok({ "@type": inst.state });
      case "setTdlibParameters": {
        if (inst.state !== "authorizationStateWaitTdlibParameters") return err(400, "Unexpected setTdlibParameters");
        const dir = String(q.database_directory);
        const key = String(q.database_encryption_key);
        inst.dir = dir;
        inst.key = key;
        const db = this.dbs.get(dir);
        if (db && db.key !== key) return err(401, "Wrong database encryption key");
        ok();
        return this.auth(clientId, inst, db?.authorised ? "authorizationStateReady" : "authorizationStateWaitPhoneNumber");
      }
      case "setAuthenticationPhoneNumber": {
        if (this.opts.stallPhone) return;
        const phone = String(q.phone_number);
        if (this.opts.floodSeconds) return err(429, `Too Many Requests: retry after ${this.opts.floodSeconds}`);
        if (phone === this.opts.banned) return err(400, "PHONE_NUMBER_BANNED");
        if (!/^\+\d{8,15}$/.test(phone)) return err(400, "PHONE_NUMBER_INVALID");
        inst.phone = phone;
        ok();
        return this.auth(clientId, inst, "authorizationStateWaitCode", {
          code_info: { "@type": "authenticationCodeInfo", phone_number: phone, type: { "@type": "authenticationCodeTypeTelegramMessage", length: 5 }, timeout: 0 },
        });
      }
      case "checkAuthenticationCode": {
        const code = String(q.code);
        if (code === this.opts.expiredCode) return err(400, "PHONE_CODE_EXPIRED");
        if (code !== TG_CODE) return err(400, "PHONE_CODE_INVALID");
        ok();
        if (this.opts.unregistered) return this.auth(clientId, inst, "authorizationStateWaitRegistration");
        if (this.opts.twoFa)
          return this.auth(clientId, inst, "authorizationStateWaitPassword", { password_hint: TG_HINT, has_recovery_email_address: false, recovery_email_address_pattern: "" });
        return this.ready(clientId, inst);
      }
      case "checkAuthenticationPassword":
        if (q.password !== TG_PASSWORD) return err(400, "PASSWORD_HASH_INVALID");
        ok();
        return this.ready(clientId, inst);
      case "getMe":
        if (inst.state !== "authorizationStateReady") return err(401, "Unauthorized");
        return ok(this.me);
      case "loadChats":
        return err(404, "Not Found");
      case "getChats":
        return ok({ "@type": "chats", total_count: this.chats.length, chat_ids: this.chats.map((c) => c.id) });
      case "getChat": {
        const c = this.chats.find((x) => x.id === q.chat_id);
        if (!c) return err(400, "Chat not found");
        return ok({
          "@type": "chat",
          id: c.id,
          title: c.title,
          type: c.type,
          unread_count: c.unread ?? 0,
          last_message: { "@type": "message", id: 9, date: 1_731_300_000, content: { "@type": "messageText", text: { "@type": "formattedText", text: "안녕" } } },
        });
      }
      case "getChatHistory":
        return ok({
          "@type": "messages",
          total_count: 2,
          messages: [
            { "@type": "message", id: 12, date: 1_731_300_100, is_outgoing: true, sender_id: { "@type": "messageSenderUser", user_id: this.me.id }, content: { "@type": "messageText", text: { "@type": "formattedText", text: "응 갈게" } } },
            { "@type": "message", id: 11, date: 1_731_300_000, is_outgoing: false, sender_id: { "@type": "messageSenderUser", user_id: 5 }, content: { "@type": "messageText", text: { "@type": "formattedText", text: "저녁 먹으러 와" } } },
          ],
        });
      case "getUser":
        return ok(q.user_id === 5 ? { "@type": "user", id: 5, first_name: "엄마" } : this.me);
      case "sendMessage": {
        const text = String(((q.input_message_content as TdObject).text as TdObject).text);
        this.sent.push({ chatId: Number(q.chat_id), text });
        return ok({ "@type": "message", id: 99, chat_id: q.chat_id });
      }
      case "logOut": {
        this.logOutCalls++;
        if (this.opts.stallLogOut) return;
        if (this.opts.logOutFails) return err(500, "Internal Server Error");
        // Telegram ends the session: the database is no longer authorised
        ok();
        if (inst.dir) {
          const db = this.dbs.get(inst.dir);
          if (db) db.authorised = false;
          this.loggedOut.push(inst.dir);
        }
        this.auth(clientId, inst, "authorizationStateLoggingOut");
        return this.auth(clientId, inst, "authorizationStateClosed");
      }
      case "close":
        ok();
        return this.auth(clientId, inst, "authorizationStateClosed");
      default:
        return err(400, `Unsupported ${String(q["@type"])}`);
    }
  }

  /** open TDLib instances that were not closed */
  get open(): number {
    return [...this.insts.values()].filter((i) => i.started && i.state !== "authorizationStateClosed").length;
  }

  private ready(clientId: number, inst: Inst): void {
    if (inst.dir && inst.key) this.dbs.set(inst.dir, { key: inst.key, authorised: true });
    this.auth(clientId, inst, "authorizationStateReady");
  }

  private auth(clientId: number, inst: Inst, state: string, extra: Record<string, unknown> = {}): void {
    inst.state = state;
    this.emit({ "@type": "updateAuthorizationState", authorization_state: { "@type": state, ...extra }, "@client_id": clientId });
  }

  private emit(ev: TdObject): void {
    const raw = JSON.stringify(ev);
    const w = this.waiting.shift();
    if (w) w(raw);
    else this.queue.push(raw);
  }
}
