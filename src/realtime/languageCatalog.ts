import type { LanguageCatalogEntry } from '@/realtime/sessionTypes'

const languageCodePattern = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i

export const languageCatalog: LanguageCatalogEntry[] = [
	{ code: 'en', label: 'English', nativeLabel: 'English', popular: true },
	{ code: 'es', label: 'Spanish', nativeLabel: 'Espanol', popular: true },
	{ code: 'fr', label: 'French', nativeLabel: 'Francais', popular: true },
	{ code: 'de', label: 'German', nativeLabel: 'Deutsch', popular: true },
	{ code: 'it', label: 'Italian', nativeLabel: 'Italiano', popular: true },
	{ code: 'pt', label: 'Portuguese', nativeLabel: 'Portugues', popular: true },
	{ code: 'pt-BR', label: 'Portuguese (Brazil)', nativeLabel: 'Portugues (Brasil)', popular: true },
	{ code: 'zh', label: 'Chinese', nativeLabel: 'Zhongwen', popular: true },
	{ code: 'ja', label: 'Japanese', nativeLabel: 'Nihongo', popular: true },
	{ code: 'ko', label: 'Korean', nativeLabel: 'Hangugeo', popular: true },
	{ code: 'ar', label: 'Arabic', nativeLabel: 'al arabia', popular: true },
	{ code: 'hi', label: 'Hindi', nativeLabel: 'Hindi', popular: true },
	{ code: 'ru', label: 'Russian', nativeLabel: 'Russkiy', popular: true },
	{ code: 'uk', label: 'Ukrainian', nativeLabel: 'Ukrayinska', popular: true },
	{ code: 'nl', label: 'Dutch', nativeLabel: 'Nederlands', popular: false },
	{ code: 'sv', label: 'Swedish', nativeLabel: 'Svenska', popular: false },
	{ code: 'no', label: 'Norwegian', nativeLabel: 'Norsk', popular: false },
	{ code: 'da', label: 'Danish', nativeLabel: 'Dansk', popular: false },
	{ code: 'fi', label: 'Finnish', nativeLabel: 'Suomi', popular: false },
	{ code: 'pl', label: 'Polish', nativeLabel: 'Polski', popular: false },
	{ code: 'cs', label: 'Czech', nativeLabel: 'Cestina', popular: false },
	{ code: 'sk', label: 'Slovak', nativeLabel: 'Slovencina', popular: false },
	{ code: 'hu', label: 'Hungarian', nativeLabel: 'Magyar', popular: false },
	{ code: 'ro', label: 'Romanian', nativeLabel: 'Romana', popular: false },
	{ code: 'bg', label: 'Bulgarian', nativeLabel: 'Balgarski', popular: false },
	{ code: 'el', label: 'Greek', nativeLabel: 'Ellinika', popular: false },
	{ code: 'tr', label: 'Turkish', nativeLabel: 'Turkce', popular: false },
	{ code: 'he', label: 'Hebrew', nativeLabel: 'Ivrit', popular: false },
	{ code: 'fa', label: 'Persian', nativeLabel: 'Farsi', popular: false },
	{ code: 'ur', label: 'Urdu', nativeLabel: 'Urdu', popular: false },
	{ code: 'bn', label: 'Bengali', nativeLabel: 'Bangla', popular: false },
	{ code: 'pa', label: 'Punjabi', nativeLabel: 'Punjabi', popular: false },
	{ code: 'ta', label: 'Tamil', nativeLabel: 'Tamil', popular: false },
	{ code: 'te', label: 'Telugu', nativeLabel: 'Telugu', popular: false },
	{ code: 'ml', label: 'Malayalam', nativeLabel: 'Malayalam', popular: false },
	{ code: 'mr', label: 'Marathi', nativeLabel: 'Marathi', popular: false },
	{ code: 'gu', label: 'Gujarati', nativeLabel: 'Gujarati', popular: false },
	{ code: 'kn', label: 'Kannada', nativeLabel: 'Kannada', popular: false },
	{ code: 'si', label: 'Sinhala', nativeLabel: 'Sinhala', popular: false },
	{ code: 'th', label: 'Thai', nativeLabel: 'Thai', popular: false },
	{ code: 'vi', label: 'Vietnamese', nativeLabel: 'Tieng Viet', popular: false },
	{ code: 'id', label: 'Indonesian', nativeLabel: 'Bahasa Indonesia', popular: false },
	{ code: 'ms', label: 'Malay', nativeLabel: 'Bahasa Melayu', popular: false },
	{ code: 'tl', label: 'Tagalog', nativeLabel: 'Tagalog', popular: false },
	{ code: 'sw', label: 'Swahili', nativeLabel: 'Kiswahili', popular: false },
	{ code: 'am', label: 'Amharic', nativeLabel: 'Amarigna', popular: false },
	{ code: 'yo', label: 'Yoruba', nativeLabel: 'Yoruba', popular: false },
	{ code: 'ig', label: 'Igbo', nativeLabel: 'Igbo', popular: false },
	{ code: 'ha', label: 'Hausa', nativeLabel: 'Hausa', popular: false },
	{ code: 'zu', label: 'Zulu', nativeLabel: 'isiZulu', popular: false },
	{ code: 'af', label: 'Afrikaans', nativeLabel: 'Afrikaans', popular: false },
	{ code: 'ca', label: 'Catalan', nativeLabel: 'Catala', popular: false },
	{ code: 'eu', label: 'Basque', nativeLabel: 'Euskara', popular: false },
	{ code: 'gl', label: 'Galician', nativeLabel: 'Galego', popular: false },
	{ code: 'is', label: 'Icelandic', nativeLabel: 'Islenska', popular: false },
	{ code: 'ga', label: 'Irish', nativeLabel: 'Gaeilge', popular: false },
	{ code: 'cy', label: 'Welsh', nativeLabel: 'Cymraeg', popular: false },
	{ code: 'et', label: 'Estonian', nativeLabel: 'Eesti', popular: false },
	{ code: 'lv', label: 'Latvian', nativeLabel: 'Latviesu', popular: false },
	{ code: 'lt', label: 'Lithuanian', nativeLabel: 'Lietuviu', popular: false },
	{ code: 'sl', label: 'Slovenian', nativeLabel: 'Slovenscina', popular: false },
	{ code: 'hr', label: 'Croatian', nativeLabel: 'Hrvatski', popular: false },
	{ code: 'sr', label: 'Serbian', nativeLabel: 'Srpski', popular: false },
	{ code: 'bs', label: 'Bosnian', nativeLabel: 'Bosanski', popular: false },
	{ code: 'mk', label: 'Macedonian', nativeLabel: 'Makedonski', popular: false },
	{ code: 'sq', label: 'Albanian', nativeLabel: 'Shqip', popular: false },
	{ code: 'hy', label: 'Armenian', nativeLabel: 'Hayeren', popular: false },
	{ code: 'ka', label: 'Georgian', nativeLabel: 'Kartuli', popular: false },
	{ code: 'kk', label: 'Kazakh', nativeLabel: 'Qazaq tili', popular: false },
	{ code: 'uz', label: 'Uzbek', nativeLabel: 'Ozbek', popular: false },
	{ code: 'mn', label: 'Mongolian', nativeLabel: 'Mongol', popular: false },
	{ code: 'ne', label: 'Nepali', nativeLabel: 'Nepali', popular: false },
	{ code: 'my', label: 'Burmese', nativeLabel: 'Myanmar', popular: false },
	{ code: 'km', label: 'Khmer', nativeLabel: 'Khmer', popular: false },
	{ code: 'lo', label: 'Lao', nativeLabel: 'Lao', popular: false },
	{ code: 'jv', label: 'Javanese', nativeLabel: 'Basa Jawa', popular: false },
	{ code: 'su', label: 'Sundanese', nativeLabel: 'Basa Sunda', popular: false },
	{ code: 'ceb', label: 'Cebuano', nativeLabel: 'Cebuano', popular: false },
	{ code: 'mi', label: 'Maori', nativeLabel: 'Te Reo Maori', popular: false },
	{ code: 'sm', label: 'Samoan', nativeLabel: 'Gagana Samoa', popular: false }
]

const languageLabelByCode = new Map(
	languageCatalog.map(catalogEntry => [catalogEntry.code.toLowerCase(), catalogEntry] as const)
)

export const popularLanguageCatalog = languageCatalog.filter(catalogEntry => catalogEntry.popular)

export function normalizeLanguageCode(languageCode: string): string {
	return languageCode.trim().toLowerCase()
}

export function resolveRealtimeTranscriptionLanguageCode(languageCode: string): null | string {
	const normalizedLanguageCode = normalizeLanguageCode(languageCode)
	const [primarySubtag = ''] = normalizedLanguageCode.split('-')
	return /^[a-z]{2,3}$/i.test(primarySubtag) ? primarySubtag : null
}

export function isValidLanguageCode(languageCode: string): boolean {
	return languageCodePattern.test(languageCode.trim())
}

function matchCatalogEntryByLabel(inputValue: string): LanguageCatalogEntry | null {
	const normalizedInputValue = inputValue.trim().toLowerCase()
	if (!normalizedInputValue) return null
	return (
		languageCatalog.find(catalogEntry => {
			const candidateList = [catalogEntry.label, catalogEntry.nativeLabel ?? '', catalogEntry.code]
			return candidateList.some(candidate => candidate.toLowerCase().includes(normalizedInputValue))
		}) ?? null
	)
}

export function resolveLanguageCode(inputValue: string, fallbackLanguageCode: string): string {
	const normalizedInputValue = normalizeLanguageCode(inputValue)
	if (isValidLanguageCode(normalizedInputValue)) return normalizedInputValue
	const matchedCatalogEntry = matchCatalogEntryByLabel(inputValue)
	if (matchedCatalogEntry) return normalizeLanguageCode(matchedCatalogEntry.code)
	return normalizeLanguageCode(fallbackLanguageCode)
}

export function resolveLanguageLabel(languageCode: string): string {
	const normalizedCode = normalizeLanguageCode(languageCode)
	const knownCatalogEntry = languageLabelByCode.get(normalizedCode)
	if (knownCatalogEntry) return knownCatalogEntry.label
	try {
		const displayNames = new Intl.DisplayNames(['en'], { type: 'language' })
		const displayLabel = displayNames.of(normalizedCode)
		if (displayLabel) return displayLabel
	} catch {}
	return normalizedCode
}
