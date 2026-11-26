/*
 * 모시 service worker: lock-screen notifications only (Web Push, B1c; lead 2045-9, SERVER-CONTRACT "Web Push (B1c)").
 *
 * - There is no fetch handler, so the worker never sits between the app and the network. It caches nothing and it
 *   cannot serve a stale app. Keep it that way: qa/push.test.ts fails if a fetch listener appears.
 * - The app registers it only after notification permission is granted (src/app/push.ts), so a device that never
 *   allowed notifications never installs it.
 * - Every push shows exactly one notification, with its sound, also while the app is on screen and shows its own
 *   banner (DD 2257: a stop line is never hidden to avoid a double; WebKit revokes a subscription that breaks
 *   userVisibleOnly). The next line of the same tag replaces the old one and alerts again (renotify). Only the title is
 *   shown. The body is always empty, whatever arrives (DD 2042-b §4: no amounts, quantities or prices).
 */
"use strict";

var OPEN = "pickle:open";
var RESUBSCRIBED = "pickle:push-resubscribed";
var FALLBACK_TITLE = "모시에서 알림이 왔어요";
var FALLBACK_TAG = "pickle:other";

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

/** WebPushPayload v1 ({ v: 1, title, body: "", tag, threadId?, messageId? }) as sent, or null when it is not one */
function readPayload(data) {
  if (!data) return null;
  var p;
  try {
    p = data.json();
  } catch (e) {
    return null;
  }
  if (!p || typeof p !== "object" || p.v !== 1) return null;
  if (typeof p.title !== "string" || !p.title.trim() || typeof p.tag !== "string" || !p.tag) return null;
  return { title: p.title.trim(), tag: p.tag, threadId: id(p.threadId), messageId: id(p.messageId) };
}

function id(x) {
  return typeof x === "string" && x ? x : undefined;
}

function windows() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true });
}

self.addEventListener("push", function (event) {
  var p = readPayload(event.data);
  event.waitUntil(
    self.registration.showNotification(p ? p.title : FALLBACK_TITLE, {
      body: "",
      tag: p ? p.tag : FALLBACK_TAG,
      data: p ? { threadId: p.threadId, messageId: p.messageId } : {},
      lang: "ko",
      renotify: true,
    }),
  );
});

/**
 * Where a tap goes when the app has to start: the thread of the line, else the investment screen for an invest
 * notification without a thread (invest:blind), else the app as it opens.
 */
function openUrl(tag, threadId, messageId) {
  var q = new URLSearchParams();
  if (threadId) {
    q.set("open", "thread");
    q.set("thread", threadId);
    if (messageId) q.set("message", messageId);
  } else if (tag.indexOf("invest:") === 0) {
    q.set("open", "invest");
  } else {
    return "/";
  }
  return "/?" + q.toString();
}

self.addEventListener("notificationclick", function (event) {
  var n = event.notification;
  n.close();
  var d = n.data || {};
  var tag = typeof n.tag === "string" ? n.tag : "";
  var threadId = id(d.threadId);
  var messageId = id(d.messageId);
  event.waitUntil(
    windows().then(function (list) {
      var win =
        list.find(function (c) {
          return c.focused;
        }) || list[0];
      if (!win) return self.clients.openWindow(openUrl(tag, threadId, messageId));
      // the app is running: it opens the target itself (src/app/push.ts), without a reload
      win.postMessage({ type: OPEN, threadId: threadId, messageId: messageId, invest: !threadId && tag.indexOf("invest:") === 0 });
      return win.focus().catch(function () {});
    }),
  );
});

/**
 * The push service replaced the subscription (Firefox). Subscribe again with the same server key and tell any running
 * app to send it to the server. With no app running, the app sends it on its next start (it does on every start).
 */
self.addEventListener("pushsubscriptionchange", function (event) {
  var old = event.oldSubscription;
  var key = old && old.options && old.options.applicationServerKey;
  var again = key
    ? self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).catch(function () {})
    : Promise.resolve();
  event.waitUntil(
    again
      .then(windows)
      .then(function (list) {
        list.forEach(function (c) {
          c.postMessage({ type: RESUBSCRIBED });
        });
      }),
  );
});
