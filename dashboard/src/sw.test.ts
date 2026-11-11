import { describe, it, expect, vi } from "vitest";
import source from "../public/sw.js?raw";
function worker() {
  const listeners: Record<string, (event: any) => void> = {};
  const show = vi.fn().mockResolvedValue(undefined),
    navigate = vi.fn().mockResolvedValue({ focus: vi.fn() }),
    open = vi.fn();
  const self = {
    location: { origin: "https://weather.test" },
    addEventListener: (key: string, fn: any) => (listeners[key] = fn),
    registration: { showNotification: show },
    clients: {
      matchAll: async () => [
        { url: "https://weather.test/", navigate, postMessage: vi.fn() },
      ],
      openWindow: open,
    },
  };
  new Function("self", source.slice(source.indexOf("self.addEventListener")))(
    self,
  );
  return { listeners, show, navigate, open };
}
describe("service worker payload and click", () => {
  it("preserves metadata and stable tag", async () => {
    const w = worker();
    let work: Promise<unknown> = Promise.resolve();
    w.listeners.push({
      data: {
        json: () => ({
          title: "Rain",
          body: "Station",
          tag: "rain:event",
          data: { url: "/?station=x#chuva", eventIds: ["event"] },
        }),
      },
      waitUntil: (p: Promise<unknown>) => (work = p),
    });
    await work;
    expect(w.show.mock.calls[0][1]).toMatchObject({
      tag: "rain:event",
      renotify: false,
      data: {
        url: "https://weather.test/?station=x#chuva",
        eventIds: ["event"],
      },
    });
  });
  it("awaits safe same-origin navigation and rejects external target", async () => {
    const w = worker();
    let work: Promise<unknown> = Promise.resolve();
    w.listeners.notificationclick({
      notification: { close: vi.fn(), data: { url: "https://evil.test/" } },
      waitUntil: (p: Promise<unknown>) => (work = p),
    });
    await work;
    expect(w.navigate).toHaveBeenCalledWith("https://weather.test/");
    expect(w.open).not.toHaveBeenCalled();
  });
  it("malformed push remains generic", async () => {
    const w = worker();
    let work: Promise<unknown> = Promise.resolve();
    w.listeners.push({
      data: {
        json: () => {
          throw Error();
        },
      },
      waitUntil: (p: Promise<unknown>) => (work = p),
    });
    await work;
    expect(w.show.mock.calls[0][0]).toBe("Meteo Data");
  });
});
