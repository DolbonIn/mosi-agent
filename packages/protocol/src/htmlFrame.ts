/**
 * The one inline script of an "html" artifact's frame (owned by the app renderer, screens-more:
 * apps/mobile/src/artifact/). The frame is `<iframe sandbox="allow-scripts" srcdoc>`, and an about:srcdoc document
 * inherits the app's CSP, so the server allows exactly this string by its sha256 (`script-src 'self' 'sha256-…'`,
 * apps/server/src/http.ts, hashed at load: the hash follows any change here) and the frame's own meta CSP by a nonce
 * made per render. Nothing the model wrote can run: it matches neither.
 *
 * Keep it a constant: the frame's channel id is read from `<html data-ch>`, never spliced into the text. What it does:
 *   - reports the content height, `{ch, type: "height", h}`, whenever #m-root resizes;
 *   - turns a tap on an https link (an <a> or <area>, wherever inside it was tapped) into
 *     `{ch, type: "open", href, text, rect}`; the app checks it and asks before opening. No link navigates the frame;
 *     other schemes and in-page anchors do nothing;
 *   - refuses form submits;
 *   - takes `{ch, type: "theme", theme, vars}` from the parent window only, so a theme switch needs no reload.
 */
export const HTML_FRAME_SCRIPT = `(function(){
var d=document,P=parent,de=d.documentElement,ch=de.getAttribute("data-ch")||"",root=d.getElementById("m-root"),last=-1;
function post(m){m.ch=ch;P.postMessage(m,"*");}
function measure(){var h=Math.ceil(root.getBoundingClientRect().height);if(h!==last){last=h;post({type:"height",h:h});}}
if(window.ResizeObserver)new ResizeObserver(measure).observe(root);
addEventListener("load",measure);
measure();
d.addEventListener("click",function(e){
var a=e.target&&e.target.closest?e.target.closest("a,area"):null;
if(!a)return;
e.preventDefault();
var href=a.getAttribute("href")||a.getAttribute("xlink:href")||"";
var abs=typeof a.href==="string"?a.href:href;
if(!/^https:/i.test(abs))return;
var r=a.getBoundingClientRect();
post({type:"open",href:String(abs),text:(a.textContent||"").replace(/\\s+/g," ").trim().slice(0,160),rect:[r.left,r.top,r.width,r.height]});
},true);
d.addEventListener("submit",function(e){e.preventDefault();},true);
addEventListener("message",function(e){
if(e.source!==P)return;
var m=e.data;
if(!m||m.ch!==ch||m.type!=="theme")return;
de.setAttribute("data-theme",m.theme==="dark"?"dark":"light");
var v=m.vars||{};
for(var k in v)if(/^--[a-z0-9-]+$/.test(k))de.style.setProperty(k,String(v[k]));
});
})();`;
