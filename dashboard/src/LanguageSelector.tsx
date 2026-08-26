import { useI18n, type Locale } from "./i18n";

const options: Array<{ value: Locale; label: string }> = [
  { value: "pt-BR", label: "🇧🇷 Português (Brasil)" },
  { value: "en", label: "🇺🇸 English" },
  { value: "es", label: "🇪🇸 Español" },
];

export default function LanguageSelector() {
  const { locale, setLocale, t } = useI18n();

  return (
    <label
      data-i18n-ignore
      style={{
        position: "fixed",
        top: "12px",
        right: "12px",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "6px 8px",
        borderRadius: "8px",
        background: "rgba(255,255,255,.92)",
        boxShadow: "0 2px 8px rgba(0,0,0,.12)",
        fontSize: "14px",
      }}
    >
      <span>{t("Language")}:</span>
      <select
        aria-label={t("Language")}
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        style={{ border: 0, background: "transparent", font: "inherit", cursor: "pointer" }}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}
