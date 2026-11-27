// snap-ivrow (lead 2230): a row value's boxes and the hairlines.
//   DD 2225 I2   each " · " item one box ("회복 / 3/6" at 320 × 130 %)
//   DD 2131 ③    a bracketed part one box, a line breaking before its "(" ("00:47(미 동부 / 10:47)"); an estimate's
//                tail "(추정, …)" in --label-2 like "(추정)"
//   DD 2225 I1   the 0.5px hairlines as inset shadows (WebKit at 3× leaves out a border-top on a half px)
//   bun test ./qa/invest-rows.test.ts
import { describe, expect, test } from "bun:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { estimate, kstWithEastern, usd } from "@pickle/quant";
import { InvestNum, IvHero, IvRow } from "../src/ui/Invest";

const html = (el: ReactElement) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/[ ⁠]/g, (c) => (c === " " ? " " : ""));
const row = (value: string) => html(createElement(IvRow, { label: "값", value }));
/** each box of a class, as its text */
const boxes = (m: string, cls: string) => {
  const out: string[] = [];
  const re = new RegExp(`<span class="${cls}">`, "g");
  for (let r = re.exec(m); r; r = re.exec(m)) {
    // the box's own text: up to its matching </span>
    let depth = 1;
    let i = r.index + r[0].length;
    const tag = /<(\/?)span\b[^>]*>/g;
    tag.lastIndex = i;
    for (let t = tag.exec(m); t; t = tag.exec(m)) {
      depth += t[1] ? -1 : 1;
      if (!depth) {
        out.push(text(m.slice(i, t.index)));
        break;
      }
    }
  }
  return out;
};

describe("a row value's boxes", () => {
  test("each \" · \" item is one box, the dot ending the item before; the words stay as given (DD 2225 I2)", () => {
    const m = row("악화 2/8 · 심각 0/5 · 회복 3/6");
    expect(text(m)).toBe("값악화 2/8 · 심각 0/5 · 회복 3/6");
    expect(boxes(m, "ivitem")).toEqual(["악화 2/8 ·", "심각 0/5 ·", "회복 3/6"]);
    expect(boxes(row("47주 · 시장가 · 정규장"), "ivitem")).toEqual(["47주 ·", "시장가 ·", "정규장"]);
    // one item: no box
    for (const v of ["$32.57", "+2.31%", "47주"]) expect(row(v)).not.toContain("ivitem");
  });

  test("a bracketed part is one box after its figure (DD 2131 ③): a time's US Eastern part, a date's", () => {
    const m = row("00:47(미 동부 10:47)");
    expect(text(m)).toBe("값00:47(미 동부 10:47)");
    expect(boxes(m, "ivgroup")).toEqual(["(미 동부 10:47)"]);
    expect(m).not.toContain("ivest");
    const at = kstWithEastern(Date.UTC(2026, 10, 26, 15, 47));
    expect(boxes(row(at), "ivgroup")).toEqual(["(미 동부 10:47)"]);
    // inside an item: the item box holds the bracket's box
    const both = row(`${at} · 토스증권`);
    expect(boxes(both, "ivitem")).toEqual([`${at} ·`, "토스증권"]);
    expect(boxes(both, "ivgroup")).toEqual(["(미 동부 10:47)"]);
  });

  test("an estimate's tail, (추정) or (추정, …), is that box in --label-2; elsewhere a (추정) is plain (DD 2224, 2131 ③)", () => {
    expect(boxes(row("약 $1,204.14(추정, 관측가 기준)"), "ivest")).toEqual(["(추정, 관측가 기준)"]);
    for (const el of [createElement(InvestNum, { value: estimate(usd(1204)) }), createElement(IvHero, { value: estimate(usd(1204)) })]) {
      expect(boxes(html(el), "ivest")).toEqual(["(추정)"]);
    }
    // a (추정) that is not the tail, a bracket that is not an estimate, the bracket alone
    expect(boxes(row("약 (추정) $3"), "ivgroup")).toEqual(["(추정)"]);
    expect(row("약 (추정) $3")).not.toContain("ivest");
    expect(row("$3(추정치)")).not.toContain("ivest");
    expect(row("(추정)")).not.toMatch(/ivest|ivgroup/);
  });

  test("a long bracket (over 24 characters inside) stays running text", () => {
    const v = "12건(어제 받은 주문 가운데 아직 체결되지 않은 것 모두)";
    expect(row(v)).not.toMatch(/ivgroup|ivest/);
    expect(text(row(v))).toBe(`값${v}`);
  });

  test("the limit is 24 characters inside, IvFoot's FOOT_GROUP's: 24 is one box, 25 stays running text (lead 0016b)", () => {
    const in24 = "어제 받은 주문 가운데 아직 체결 안 된 것";
    const in25 = `${in24}들`;
    expect([in24.length, in25.length]).toEqual([24, 25]);
    const at24 = row(`12건(${in24})`);
    expect(boxes(at24, "ivgroup")).toEqual([`(${in24})`]);
    expect(text(at24)).toBe(`값12건(${in24})`);
    const at25 = row(`12건(${in25})`);
    expect(at25).not.toMatch(/ivgroup|ivest/);
    expect(text(at25)).toBe(`값12건(${in25})`);
    // the same limit inside a " · " item
    const item = row(`체결 3건 · 12건(${in24})`);
    expect(boxes(item, "ivgroup")).toEqual([`(${in24})`]);
    expect(row(`체결 3건 · 12건(${in25})`)).not.toMatch(/ivgroup/);
  });
});

describe("styles", () => {
  const read = (f: string) => readFileSync(join(import.meta.dir, "../src", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** the declarations of a rule whose whole selector list is `sel`, as written */
  const rule = (css: string, sel: string) => {
    const m = new RegExp(`(?:^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
    return m ? m[1]!.trim() : null;
  };
  test("an item, a bracket and an estimate's tail are boxes: whole on a line while they fit one; the tail in --label-2", () => {
    const css = read("ui/Invest.css");
    expect(rule(css, ".ivitem,\n.ivgroup,\n.ivest")).toBe("display: inline-block;");
    expect(rule(css, ".ivest")).toBe("color: var(--label-2);");
    // never nowrap: a box wider than the whole value cell may still wrap inside it rather than run past the card
    expect(css).not.toMatch(/\.iv(item|group|est)[^{]*\{[^}]*nowrap/);
  });
  test("the three 0.5px hairlines are inset shadows; no 0.5px border-top is left in either file (DD 2225 I1)", () => {
    const inv = read("ui/Invest.css");
    const dr = read("app/Drawer.css");
    for (const css of [inv, dr]) expect(css).not.toMatch(/border-top:\s*0\.5px/);
    const LINE = "box-shadow: inset 0 0.5px 0 var(--separator);";
    expect(rule(inv, ".ivrows")).toContain(LINE);
    expect(rule(inv, ".ivdisclaimer")).toContain(LINE);
    expect(rule(dr, ".drawer-extra")).toContain(LINE);
    // the drawer's extra content alone has no line
    expect(rule(dr, ".drawer-extra[data-alone]")).toContain("box-shadow: none;");
    expect(rule(dr, ".drawer-extra[data-alone]")).not.toContain("border-top");
  });
});
