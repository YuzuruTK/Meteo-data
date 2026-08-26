import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { ptBR } from "./locales/pt-BR";

export type Locale = "pt-BR" | "en" | "es";

const STORAGE_KEY = "meteo-data-locale";
const DEFAULT_LOCALE: Locale = "pt-BR";
const resources: Record<Locale, Record<string, string>> = { "pt-BR": ptBR, en, es };
const supportedLocales = Object.keys(resources) as Locale[];

const originalText = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();
let activeLocale: Locale = DEFAULT_LOCALE;
let observer: MutationObserver | null = null;
let applying = false;
let frame: number | null = null;
const pending = new Set<Node>();

function isSupported(value: string | null | undefined): value is Locale {
  return !!value && supportedLocales.includes(value as Locale);
}

export function detectLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (isSupported(stored)) return stored;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const language of languages) {
    const normalized = language.toLowerCase();
    if (normalized === "pt-br" || normalized.startsWith("pt-")) return "pt-BR";
    if (normalized === "en" || normalized.startsWith("en-")) return "en";
    if (normalized === "es" || normalized.startsWith("es-")) return "es";
  }
  return DEFAULT_LOCALE;
}

export function translateValue(value: string, locale: Locale): string {
  if (locale === "en") return value;
  let result = value;
  for (const [source, target] of Object.entries(resources[locale]).sort(([a], [b]) => b.length - a.length)) {
    result = result.split(source).join(target);
  }
  result = result.replace(/(\d+)\s+hours\b/g, "$1 horas");
  if (locale === "pt-BR") {
    result = result.replace(/\bstations\b/g, "estações").replace(/\bstation\b/g, "estação").replace(/\bgust\b/g, "rajada").replace(/\bno data\b/g, "sem dados");
  } else {
    result = result.replace(/\bstations\b/g, "estaciones").replace(/\bstation\b/g, "estación").replace(/\bgust\b/g, "ráfaga").replace(/\bno data\b/g, "sin datos");
  }
  return result;
}

function shouldIgnore(node: Node): boolean {
  return node.parentElement?.closest("[data-i18n-ignore]") !== null;
}

function translateTextNode(node: Text): void {
  if (shouldIgnore(node)) return;
  const current = node.nodeValue ?? "";
  if (!originalText.has(node)) originalText.set(node, current);
  const source = originalText.get(node) ?? current;
  const translated = translateValue(source, activeLocale);
  if (translated !== current) node.nodeValue = translated;
}

function translateAttributes(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>("[title], [aria-label]")) {
    if (element.closest("[data-i18n-ignore]")) continue;
    let values = originalAttributes.get(element);
    if (!values) { values = new Map(); originalAttributes.set(element, values); }
    for (const attribute of ["title", "aria-label"] as const) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      if (!values.has(attribute)) values.set(attribute, value);
      element.setAttribute(attribute, translateValue(values.get(attribute) ?? value, activeLocale));
    }
  }
}

function translateRoot(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) { translateTextNode(root as Text); return; }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
  if (root instanceof Element && root.hasAttribute("data-i18n-ignore")) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  for (const textNode of nodes) translateTextNode(textNode);
  if (root instanceof Element || root instanceof DocumentFragment) translateAttributes(root);
}

function flushPending(): void {
  frame = null;
  applying = true;
  try { for (const node of pending) if (node.isConnected || node === document.body) translateRoot(node); }
  finally { pending.clear(); applying = false; }
}

function schedule(node: Node): void {
  pending.add(node);
  if (frame === null) frame = window.requestAnimationFrame(flushPending);
}

export function applyLocale(locale: Locale): void {
  activeLocale = locale;
  if (typeof document === "undefined") return;
  applying = true;
  try {
    document.documentElement.lang = locale;
    document.title = translateValue("Meteo Data Dashboard", locale);
    if (document.body) translateRoot(document.body);
  } finally { applying = false; }
}

export function getActiveLocale(): Locale { return activeLocale; }

export function formatHour(hour: string): string {
  const d = new Date(hour + ":00Z");
  if (Number.isNaN(d.getTime())) return hour;
  return d.toLocaleString(activeLocale === "pt-BR" ? "pt-BR" : activeLocale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function startObserver(): () => void {
  if (typeof document === "undefined" || !document.body) return () => undefined;
  observer?.disconnect();
  observer = new MutationObserver((mutations) => {
    if (applying) return;
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const text = mutation.target as Text;
        if (!originalText.has(text)) originalText.set(text, text.nodeValue ?? "");
        else if (text.nodeValue !== translateValue(originalText.get(text) ?? "", activeLocale)) originalText.set(text, text.nodeValue ?? "");
        schedule(mutation.target);
      } else {
        for (const node of mutation.addedNodes) schedule(node);
        if (mutation.target instanceof Element) schedule(mutation.target);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  applyLocale(activeLocale);
  return () => {
    observer?.disconnect(); observer = null;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null; pending.clear();
  };
}

interface I18nContextValue { locale: Locale; setLocale: (locale: Locale) => void; t: (value: string) => string; }
const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    activeLocale = next;
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, next);
    applyLocale(next);
  }, []);
  useEffect(() => { activeLocale = locale; return startObserver(); }, []);
  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t: (value: string) => translateValue(value, locale) }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}

export { resources };
