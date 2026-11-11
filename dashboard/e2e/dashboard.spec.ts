import { test, expect } from "@playwright/test";
const stations = [
  { id: "ijui-iiJu2", name: "Ijuí" },
  { id: "ijui-iiJu3", name: "Floresta" },
  { id: "ijui-iiJu5", name: "Mundstock" },
  { id: "ijui-iiJu7", name: "Itaí" },
];
async function fixtures(page: any, scenario = "rain") {
  await page.addInitScript(() =>
    localStorage.setItem("meteo-data-locale", "pt-BR"),
  );
  await page.route("**/api/**", async (route: any) => {
    const url = new URL(route.request().url()),
      now = Date.now();
    let body: any = {};
    if (url.pathname === "/api/stations") body = { stations };
    if (url.pathname === "/api/summary")
      body = {
        meta: { serverTime: new Date(now).toISOString() },
        summaries: stations.map((s, i) => ({
          location_id: s.id,
          station_name: s.name,
          observed_at: new Date(
            now - (scenario === "stale" ? 1200000 : i === 3 ? 1800000 : 60000),
          ).toISOString(),
          temperature: 23.4 + i,
          humidity: 76,
          pressure: 1012.5,
          wind_speed: 12,
          wind_gust: 18,
          wind_direction: 90,
          precipitation_rate:
            scenario === "null"
              ? null
              : scenario === "dry"
                ? 0
                : i < 2
                  ? 1.2
                  : 0,
          precipitation_total: 4,
          solar_radiation: 200,
          uv_index: 2,
          cloud_cover: null,
          visibility: null,
        })),
      };
    if (url.pathname === "/api/observations/aggregate") {
      if (scenario === "maintenance")
        return route.fulfill({ status: 503, json: { maintenance: true } });
      const selected = url.searchParams.get("station");
      if (selected === "ijui-iiJu2")
        await new Promise((resolve) => setTimeout(resolve, 250));
      body = {
        rows: stations
          .filter((s) => !selected || s.id === selected)
          .flatMap((s) =>
            Array.from({ length: 24 }, (_, i) => ({
              station_id: s.id,
              station_name: s.name,
              hour:
                new Date(Math.floor(now / 3600000) * 3600000 - i * 3600000)
                  .toISOString()
                  .slice(0, 13)
                  .replace("T", " ") + ":00",
              temperature_avg: i === 7 ? null : 20 + i / 10,
              humidity_avg: 70,
              precipitation_rate_avg: 0.2,
            })),
          ),
        filters: { hours: 24, station: selected },
        columns: [],
      };
    }
    if (url.pathname === "/api/forecast") {
      if (scenario === "maintenance")
        return route.fulfill({ status: 502, json: {} });
      body = {
        hourly: Array.from({ length: 24 }, (_, i) => ({
          time: new Date(now + i * 3600000).toISOString(),
          temperature: 19 + i / 5,
          precipitationProbability: 70,
          precipitation: 1,
          humidity: 75,
          cloudCover: 50,
        })),
      };
    }
    if (url.pathname === "/api/push/public-key")
      return route.fulfill({ status: 503, json: {} });
    await route.fulfill({ json: body });
  });
}
for (const width of [320, 360, 768, 1024, 1440])
  test(`responsive ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixtures(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Chuva detectada · 2 / 3" }),
    ).toBeVisible();
    await expect(page.locator(".temperature").first()).toContainText("23,4");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Configurar alertas" }).click();
    await expect(
      page.getByText("Início de chuva observado", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `../docs/evidence/dashboard-${width}.png`,
      fullPage: true,
    });
  });
for (const scenario of ["dry", "stale", "null", "maintenance"])
  test(`state ${scenario}`, async ({ page }) => {
    await fixtures(page, scenario);
    await page.goto("/");
    await expect(page.locator(".temperature").first()).toContainText("23,4");
    if (scenario === "maintenance")
      await expect(page.getByRole("alert").first()).toBeVisible();
    await page.screenshot({
      path: `../docs/evidence/dashboard-${scenario}.png`,
      fullPage: true,
    });
  });
test("filters, deep link, back and translations", async ({ page }) => {
  await fixtures(page);
  await page.goto("/?station=ijui-iiJu3&hours=6#chuva");
  await expect(page.locator(".rain-readings strong")).toHaveText("Floresta");
  const select = page.locator(".toolbar select");
  await select.selectOption("ijui-iiJu2");
  await select.selectOption("ijui-iiJu7");
  await expect(page.locator(".rain-readings strong")).toHaveText("Itaí");
  await page.goBack();
  await expect(page.locator(".rain-readings strong")).toHaveText("Ijuí");
  await page.locator("header select").selectOption("es");
  await expect(
    page.getByRole("heading", { name: "Últimas observaciones" }),
  ).toBeVisible();
  await page.locator("header select").selectOption("en");
  await expect(
    page.getByRole("heading", { name: "Latest observations" }),
  ).toBeVisible();
});
test("no polling when local clock advances beyond freshness threshold", async ({
  page,
}) => {
  await fixtures(page);
  await page.clock.install();
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Chuva detectada · 2 / 3" }),
  ).toBeVisible();
  let count = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/")) count++;
  });
  await page.clock.fastForward(20 * 60000);
  await expect(
    page.getByRole("heading", { name: "Sem leitura de chuva disponível" }),
  ).toBeVisible();
  expect(count).toBe(0);
});
async function fakePush(page: any) {
  await page.addInitScript(() => {
    let subscribed = false;
    const sub = {
      endpoint: "https://fcm.googleapis.com/test-device",
      toJSON: () => ({
        endpoint: "https://fcm.googleapis.com/test-device",
        keys: { p256dh: "test-key", auth: "test-auth" },
      }),
      unsubscribe: async () => {
        subscribed = false;
        return true;
      },
    };
    const registration = {
      pushManager: {
        getSubscription: async () => (subscribed ? sub : null),
        subscribe: async () => {
          subscribed = true;
          return sub;
        },
      },
    };
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    Notification.requestPermission = async () => "granted";
    navigator.serviceWorker.register = async () => registration as any;
    Object.defineProperty(navigator.serviceWorker, "ready", {
      get: () => Promise.resolve(registration),
    });
  });
}
for (const failed of [false, true])
  test(`push server confirmation ${failed ? "pending" : "active"}`, async ({
    page,
  }) => {
    await fixtures(page);
    await fakePush(page);
    await page.route("**/api/push**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("public-key"))
        return route.fulfill({
          json: { publicKey: btoa(String.fromCharCode(4) + "x".repeat(64)) },
        });
      if (path === "/api/push-subscribe")
        return route.fulfill({
          status: failed ? 503 : 200,
          json: failed
            ? {}
            : {
                ok: true,
                preferences: JSON.parse(route.request().postData()!)
                  .preferences,
              },
        });
      return route.fulfill({ status: 404, json: {} });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Configurar alertas" }).click();
    await page
      .getByRole("button", { name: "Ativar notificações neste dispositivo" })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({
          hasText: failed
            ? "Ativação incompleta"
            : "Alertas ativos neste dispositivo",
        }),
    ).toBeVisible();
    if (failed)
      await expect(
        page.getByText("Alertas ativos neste dispositivo", { exact: true }),
      ).toHaveCount(0);
    await page.screenshot({
      path: `../docs/evidence/push-${failed ? "pending" : "active"}.png`,
      fullPage: true,
    });
  });
test("keyboard skip link and 200 percent layout", async ({ page }) => {
  await fixtures(page);
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Ir para condições do tempo" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#chuva")).toBeFocused();
  await page.evaluate(() => (document.documentElement.style.fontSize = "200%"));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
