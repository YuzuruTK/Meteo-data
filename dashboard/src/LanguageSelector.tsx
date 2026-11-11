import { useI18n, type Locale } from "./i18n";

const options: Array<{ value: Locale; label: string }> = [
  { value: "pt-BR", label: "🇧🇷 Português (Brasil)" },
  { value: "en", label: "🇺🇸 English" },
  { value: "es", label: "🇪🇸 Español" },
];

export default function LanguageSelector() {
  const { locale, setLocale } = useI18n();

  return (
    <label data-i18n-ignore>
      <span>
        {locale === "pt-BR"
          ? "Idioma"
          : locale === "es"
            ? "Idioma"
            : "Language"}
        :
      </span>
      <select
        aria-label={
          locale === "pt-BR"
            ? "Idioma"
            : locale === "es"
              ? "Idioma"
              : "Language"
        }
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
        style={{
          border: 0,
          background: "transparent",
          font: "inherit",
          cursor: "pointer",
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
