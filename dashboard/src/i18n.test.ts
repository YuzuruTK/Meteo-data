import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyLocale,
  detectLocale,
  startObserver,
  translateValue,
} from "./i18n";

const STORAGE_KEY = "meteo-data-locale";

function setNavigatorLanguage(language: string): void {
  Object.defineProperty(navigator, "language", { value: language, configurable: true });
  Object.defineProperty(navigator, "languages", { value: [language], configurable: true });
}

function probeText(id: string): string {
  return document.getElementById(id)?.textContent ?? "";
}

const stopObservers: (() => void)[] = [];

describe("detectLocale", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("gives a saved locale in localStorage priority over navigator", () => {
    setNavigatorLanguage("pt-BR");
    localStorage.setItem(STORAGE_KEY, "en");
    expect(detectLocale()).toBe("en");
  });

  it.each(["pt-BR", "pt-PT", "pt-br"])("maps %s to pt-BR", (language) => {
    setNavigatorLanguage(language);
    expect(detectLocale()).toBe("pt-BR");
  });

  it("maps en-US to en", () => {
    setNavigatorLanguage("en-US");
    expect(detectLocale()).toBe("en");
  });

  it("maps es-ES to es", () => {
    setNavigatorLanguage("es-ES");
    expect(detectLocale()).toBe("es");
  });

  it("uses pt-BR for unsupported languages", () => {
    setNavigatorLanguage("fr-FR");
    expect(detectLocale()).toBe("pt-BR");
  });
});
describe("translateValue", () => {
  it("translates into pt-BR", () => {
    expect(translateValue("Temperature", "pt-BR")).toBe("Temperatura");
  });

  it("keeps strings unchanged for en", () => {
    expect(translateValue("Temperature", "en")).toBe("Temperature");
  });

  it("translates into es", () => {
    expect(translateValue("Wind", "es")).toBe("Viento");
  });

  it("returns untranslated strings as-is", () => {
    expect(translateValue("Some unknown string", "pt-BR")).toBe("Some unknown string");
  });

  it("applies the pt-BR post-processing rules", () => {
    expect(translateValue("Next 24 hours", "pt-BR")).toContain("24 horas");
    expect(translateValue("5 stations", "pt-BR")).toBe("5 estações");
  });

  it("applies the es post-processing rules", () => {
    expect(translateValue("5 stations", "es")).toBe("5 estaciones");
    expect(translateValue("Next 24 hours", "es")).toBe("Next 24 horas");
  });
});

describe("locale switching against the real DOM", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "";
    document.documentElement.lang = "";
    localStorage.clear();
    applyLocale("en");
  });

  it("switches EN -> PT-BR -> EN without losing the source text", () => {
    document.body.innerHTML = '<div id="probe">Wind</div>';
    applyLocale("en");
    expect(probeText("probe")).toBe("Wind");

    applyLocale("pt-BR");
    expect(probeText("probe")).toBe("Vento");

    applyLocale("en");
    expect(probeText("probe")).toBe("Wind");
  });

  it("switches EN -> PT-BR -> ES -> EN repeatedly without accumulating translations", () => {
    document.body.innerHTML = '<div id="probe">Wind</div>';
    applyLocale("en");

    applyLocale("pt-BR");
    expect(probeText("probe")).toBe("Vento");

    applyLocale("es");
    expect(probeText("probe")).toBe("Viento");

    applyLocale("en");
    expect(probeText("probe")).toBe("Wind");

    applyLocale("pt-BR");
    expect(probeText("probe")).toBe("Vento");
  });

  it("keeps documentElement.lang and document.title in sync", () => {
    applyLocale("pt-BR");
    expect(document.documentElement.lang).toBe("pt-BR");
    expect(document.title).toBe("Painel Meteo Data");

    applyLocale("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.title).toBe("Meteo Data Dashboard");
  });

  it("translates title and aria-label attributes", () => {
    document.body.innerHTML =
      '<button id="btn" title="Temperature" aria-label="Show pressure">OK</button>';

    applyLocale("pt-BR");
    const btn = document.querySelector<HTMLButtonElement>("#btn")!;
    expect(btn.title).toBe("Temperatura");
    expect(btn.getAttribute("aria-label")).toBe("Mostrar pressão");

    applyLocale("en");
    expect(btn.title).toBe("Temperature");
    expect(btn.getAttribute("aria-label")).toBe("Show pressure");
  });

  it("respects data-i18n-ignore", () => {
    document.body.innerHTML =
      '<div data-i18n-ignore><span class="probe">Temperature</span></div>' +
      '<div><span class="probe">Humidity</span></div>';

    applyLocale("pt-BR");
    const probes = document.querySelectorAll<HTMLElement>(".probe");
    expect(probes[0].textContent).toBe("Temperature");
    expect(probes[1].textContent).toBe("Umidade");
  });
});
describe("MutationObserver integration", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "";
    document.documentElement.lang = "";
    localStorage.clear();
    applyLocale("en");
  });

  afterEach(() => {
    for (const stop of stopObservers) stop();
    stopObservers.length = 0;
  });

  it("translates dynamically-added content and keeps its source", async () => {
    document.body.innerHTML = '<div id="existing">Temperature</div>';
    const stop = startObserver();
    stopObservers.push(stop);

    applyLocale("pt-BR");
    expect(probeText("existing")).toBe("Temperatura");

    // Dynamic content added after initialization.
    const dynamic = document.createElement("div");
    dynamic.id = "dynamic";
    dynamic.textContent = "Humidity";
    document.body.appendChild(dynamic);

    // The MutationObserver should pick it up without another applyLocale call.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(probeText("dynamic")).toBe("Umidade");

    applyLocale("es");
    expect(probeText("dynamic")).toBe("Humedad");

    applyLocale("en");
    expect(probeText("dynamic")).toBe("Humidity");
  });

  it("does not overwrite the source text when it observes its own translation", async () => {
    document.body.innerHTML = '<div id="probe">Temperature</div>';
    const stop = startObserver();
    stopObservers.push(stop);

    applyLocale("pt-BR");
    expect(probeText("probe")).toBe("Temperatura");

    // Let the observer deliver the characterData mutation caused by our own
    // translation and finish any scheduled work. The source must survive.
    await new Promise((resolve) => setTimeout(resolve, 80));

    applyLocale("en");
    expect(probeText("probe")).toBe("Temperature");
  });
});

