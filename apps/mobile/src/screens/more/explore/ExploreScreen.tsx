import type { TaskTemplate, TemplateCategory } from "@pickle/protocol";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAgent, useUi } from "../../../api/store";
import { nav, type ScreenProps } from "../../../app/nav";
import { Screen } from "../../../app/Screen";
import { BrandIcon } from "../../../assets/brands/BrandIcon";
import { ContentSwap } from "../../../motion/ContentSwap";
import { getTier } from "../../../motion/tier";
import { Avatar, DEFAULT_AVATAR } from "../../../ui/Avatar";
import { EmptyState } from "../../../ui/EmptyState";
import { R } from "../../../ui/geometry";
import { Icon, type AppIconName } from "../../../ui/Icon";
import { LargeTitle } from "../../../ui/LargeTitle";
import { exploreRes, useResource } from "../data";
import { delegatedCount } from "../format";
import { InlineError, Placeholder, Stack, useAgentName, useTabVisible } from "../parts";
import { usePhone } from "../profile/phone";
import { presentPhone } from "../profile/PhoneSheet";
import { CategoryRail } from "./CategoryRail";
import { PreDelegateSheet } from "./PreDelegateSheet";
import { brandFor } from "./templateInfo";
import "./explore.css";

/**
 * 둘러보기 (MOTION-SPEC §6.4 + §8.9, draft B "추천은 나에게, 전체는 한 번 더"): one large title that hands over to the
 * bar; a text rail (추천 · 전체 · 혜택 …) with the two-edge droplet; switching category is a directional content swap.
 *   추천 = "<agentName>의 제안" (signed with the agent's face) + the first two 추천 templates it did not already suggest,
 *          closed by "맡길 수 있는 일 전체 N개" (the real list length), which selects 전체
 *   전체 = every template; the other words filter client-side by template.category
 * Rows lead with the title (2-line description, the whole row is the button, no per-row accent). A row about a real
 * service leads with its app icon (BrandIcon 30, R.plate, as Connections); the rest keep a bare 22 px glyph, no tile.
 * A row morphs into the pre-delegation sheet; connect-kakao opens Connections instead. call-demo without a verified
 * number: "인증하고 받아 보기" hands the screen to the phone sheet (one sheet at a time); when that sheet has gone and the
 * server says the number is verified, the pre-delegation sheet morphs back out of its row with "전화 받아 보기".
 */

/** 전체 is the client's own entry, right after 추천 (the server's list has no catalogue word) */
const ALL: TemplateCategory = { id: "all", title: "전체", icon: "compass" };
/** how many first-try templates 추천 shows under the suggestions */
const FIRST_TRIES = 2;

export function ExploreScreen({ route }: ScreenProps) {
  const ui = useUi();
  const visible = useTabVisible("explore");
  const res = useResource(exploreRes, visible);
  const agentName = useAgentName();
  const avatar = useAgent()?.avatar ?? DEFAULT_AVATAR;
  const [cat, setCat] = useState("recommend");
  const dir = useRef<-1 | 1>(1);
  const rail = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ tpl: TaskTemplate; source: HTMLElement; open: boolean } | null>(null);
  const phone = usePhone();
  const verified = useRef(false);
  verified.current = !!phone?.verified;
  const watch = useRef<MutationObserver | null>(null);
  useEffect(() => () => watch.current?.disconnect(), []);

  const categories = useMemo(() => {
    const base = res.data?.categories?.length ? res.data.categories : ui.explore.categories;
    if (base.some((c) => c.id === ALL.id)) return base;
    const at = base.findIndex((c) => c.id === "recommend");
    return [...base.slice(0, at + 1), ALL, ...base.slice(at + 1)];
  }, [res.data?.categories, ui.explore.categories]);
  const popular = useMemo(() => res.data?.popular ?? [], [res.data?.popular]);
  const suggestions = useMemo(() => res.data?.suggestions ?? [], [res.data?.suggestions]);
  const firstTries = useMemo(() => {
    const suggested = new Set(suggestions.map((t) => t.id));
    return popular.filter((t) => t.category === "recommend" && !suggested.has(t.id)).slice(0, FIRST_TRIES);
  }, [popular, suggestions]);
  const list = useMemo(() => (cat === ALL.id ? popular : popular.filter((t) => t.category === cat)), [popular, cat]);
  const catTitle = categories.find((c) => c.id === cat)?.title;

  const changeCat = useCallback(
    (id: string) => {
      const order = categories.map((c) => c.id);
      dir.current = order.indexOf(id) >= order.indexOf(cat) ? 1 : -1;
      setCat(id);
    },
    [categories, cat],
  );

  // "맡길 수 있는 일 전체" at the end of 추천: select 전체 and bring the rail back under the bar if it scrolled away
  const showAll = useCallback(() => {
    changeCat(ALL.id);
    const el = rail.current;
    const sc = el?.closest<HTMLElement>(".screen-scroll");
    if (!el || !sc) return;
    const clear = parseFloat(getComputedStyle(sc).paddingTop) || 0;
    if (el.getBoundingClientRect().top < sc.getBoundingClientRect().top + clear) {
      el.scrollIntoView({ block: "start", behavior: getTier().reduceMotion ? "auto" : "smooth" });
    }
  }, [changeCat]);

  // "인증하고 받아 보기": the phone sheet replaces the pre-delegation sheet. Sheets mark <html data-overlay> while they are
  // modal; once no sheet is left, reopen the same template from its row if (and only if) the number is now verified.
  const needPhone = useCallback(
    (el: HTMLElement) => {
      const back = sel ? { tpl: sel.tpl, source: sel.source } : null;
      presentPhone(el);
      if (!back) return;
      watch.current?.disconnect();
      const html = document.documentElement;
      const mo = new MutationObserver(() => {
        if ((html.dataset.overlay ?? "").split(" ").some((o) => o.startsWith("sheet"))) return;
        mo.disconnect();
        watch.current = null;
        if (verified.current && back.source.isConnected) setSel({ ...back, open: true });
      });
      mo.observe(html, { attributes: true, attributeFilter: ["data-overlay"] });
      watch.current = mo;
    },
    [sel],
  );

  const open = useCallback((tpl: TaskTemplate, el: HTMLElement) => {
    if (tpl.id === "connect-kakao") {
      nav.push("connections", { focus: "kakaotalk" }, { title: "앱 연결" });
      return;
    }
    setSel({ tpl, source: el, open: true });
  }, []);

  return (
    <Screen routeKey={route.key} className="explore">
      <LargeTitle title={ui.explore.title || "둘러보기"} />
      <Stack gap={24}>
        <div ref={rail} className="explore-rail">
          <CategoryRail categories={categories} value={cat} onChange={changeCat} />
        </div>

        {!res.loaded && !res.data ? (
          res.error ? (
            <InlineError>{res.error}</InlineError>
          ) : (
            <Placeholder rows={3} height={132} />
          )
        ) : (
          <ContentSwap swapKey={cat} display="block" as="div" direction={dir.current}>
            {cat === "recommend" ? (
              <Stack gap={24}>
                {suggestions.length > 0 && (
                  <section aria-labelledby="explore-suggest">
                    <h2 className="explore-h explore-h--agent" id="explore-suggest">
                      <Avatar spec={avatar} size={18} />
                      {agentName}의 제안
                    </h2>
                    <TemplateList items={suggestions} onOpen={open} label={`${agentName}의 제안`} suggestion />
                  </section>
                )}
                {popular.length > 0 ? (
                  <section aria-labelledby="explore-popular">
                    <h2 className="explore-h" id="explore-popular">
                      맡길 수 있는 일
                    </h2>
                    <TemplateList items={firstTries} onOpen={open} label="맡길 수 있는 일" end={<AllRow count={popular.length} onPress={showAll} />} />
                  </section>
                ) : (
                  suggestions.length === 0 && <EmptyState icon="compass" title="아직 맡길 수 있는 일이 없어요" body="곧 새로운 일을 채워 둘게요." />
                )}
              </Stack>
            ) : (
              <section aria-labelledby="explore-popular">
                <h2 className="explore-h" id="explore-popular">
                  {cat === ALL.id || !catTitle ? "맡길 수 있는 일" : `${catTitle}에서 맡길 수 있는 일`}
                </h2>
                {list.length ? (
                  <TemplateList items={list} onOpen={open} label={catTitle ?? "맡길 수 있는 일"} />
                ) : (
                  <EmptyState icon="compass" title="아직 이 분야에 맡길 수 있는 일이 없어요" body="곧 새로운 일을 채워 둘게요." />
                )}
              </section>
            )}
          </ContentSwap>
        )}
      </Stack>

      {sel && (
        <PreDelegateSheet
          tpl={sel.tpl}
          source={sel.source}
          open={sel.open}
          onClose={() => setSel((s) => (s ? { ...s, open: false } : s))}
          onClosed={() => setSel((s) => (s && !s.open ? null : s))}
          onNeedPhone={needPhone}
        />
      )}
    </Screen>
  );
}

const realCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

function TemplateList({ items, onOpen, label, suggestion, end }: { items: TaskTemplate[]; onOpen: (t: TaskTemplate, el: HTMLElement) => void; label: string; suggestion?: boolean; end?: ReactNode }) {
  return (
    <ul className="tpl-list" aria-label={label}>
      {items.map((t) => (
        <li key={t.id}>
          <TemplateRow tpl={t} onOpen={onOpen} suggestion={suggestion} />
        </li>
      ))}
      {end && <li>{end}</li>}
    </ul>
  );
}

function TemplateRow({ tpl, onOpen, suggestion }: { tpl: TaskTemplate; onOpen: (t: TaskTemplate, el: HTMLElement) => void; suggestion?: boolean }) {
  const isConnect = tpl.id === "connect-kakao";
  const brand = brandFor(tpl);
  // "N명이 맡겼어요" only for a real, positive count from the server: no seed, no placeholder (CP-7, PRODUCT.md
  // "do not fabricate"); a missing, null or zero count shows nothing
  const showCount = !suggestion && realCount(tpl.count);
  const aria = [tpl.title, tpl.description, showCount ? delegatedCount(tpl.count) : null, isConnect ? "연결 화면 열기" : null].filter(Boolean).join(", ");
  return (
    <button type="button" className="tpl-row" data-tpl={tpl.id} data-brand={brand ?? undefined} aria-label={aria} onClick={(e) => onOpen(tpl, e.currentTarget)}>
      <span className="tpl-lead" aria-hidden="true">
        {brand ? <BrandIcon provider={brand} size={30} radius={R.plate} /> : <Icon name={tpl.icon as AppIconName} size={22} />}
      </span>
      <span className="tpl-main">
        <span className="tpl-title">{tpl.title}</span>
        <span className="tpl-desc">{tpl.description}</span>
        {showCount && (
          <span className="tpl-count tnum">
            <Icon name="people" size={15} weight="medium" />
            {delegatedCount(tpl.count)}
          </span>
        )}
        {isConnect && (
          <span className="tpl-count">
            <Icon name="link" size={15} weight="medium" />
            연결하면 바로 쓸 수 있어요
          </span>
        )}
      </span>
      <span className="tpl-chevron" aria-hidden="true">
        <Icon name="chevron-right" size={16} weight="semibold" />
      </span>
    </button>
  );
}

/** the last row of 추천: the catalogue, one more step away; the number is the real list length */
function AllRow({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <button type="button" className="tpl-all" aria-label={`맡길 수 있는 일 전체 ${count}개 보기`} onClick={onPress}>
      <span className="tpl-all-title">맡길 수 있는 일 전체</span>
      <span className="tpl-all-end" aria-hidden="true">
        <span className="tnum">{count}개</span>
        <Icon name="chevron-right" size={16} weight="semibold" />
      </span>
    </button>
  );
}
