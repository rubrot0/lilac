'use client'

import { ArrowRightLeft } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import {
	languageCatalog,
	popularLanguageCatalog,
	resolveLanguageCode,
	resolveLanguageLabel
} from '@/realtime/languageCatalog'
import { useLilacModeRuntime } from '@/realtime/modeRuntimeStore'

function buildLanguageList(): Array<{ code: string; label: string }> {
	const popularCodeSet = new Set(popularLanguageCatalog.map(language => language.code.toLowerCase()))
	const popularLanguageList = popularLanguageCatalog.map(language => ({
		code: language.code,
		label: language.label
	}))
	const standardLanguageList = languageCatalog
		.filter(language => !popularCodeSet.has(language.code.toLowerCase()))
		.map(language => ({
			code: language.code,
			label: language.label
		}))
		.sort((left, right) => left.label.localeCompare(right.label))
	return [...popularLanguageList, ...standardLanguageList]
}

const orderedLanguageList = buildLanguageList()

type LanguagePickerFieldProps = {
	customCodeValue: string
	label: string
	onChange: (nextLanguageCode: string) => void
	onCustomCodeValueChange: (value: string) => void
	testId: string
	value: string
}

function LanguagePickerField({
	customCodeValue,
	label,
	onChange,
	onCustomCodeValueChange,
	testId,
	value
}: LanguagePickerFieldProps) {
	const [searchValue, setSearchValue] = useState('')

	const filteredLanguageList = useMemo(() => {
		const normalizedSearchValue = searchValue.trim().toLowerCase()
		if (!normalizedSearchValue) return orderedLanguageList.slice(0, 14)
		return orderedLanguageList
			.filter(languageOption => {
				const normalizedLabel = languageOption.label.toLowerCase()
				const normalizedCode = languageOption.code.toLowerCase()
				return (
					normalizedLabel.includes(normalizedSearchValue) ||
					normalizedCode.includes(normalizedSearchValue)
				)
			})
			.slice(0, 18)
	}, [searchValue])

	function applyCustomCode(): void {
		const resolvedLanguageCode = resolveLanguageCode(customCodeValue, value)
		onChange(resolvedLanguageCode)
		onCustomCodeValueChange(resolvedLanguageCode)
	}

	return (
		<div className="space-y-2">
			<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
				{label}
			</div>
			<Input
				value={searchValue}
				onChange={event => setSearchValue(event.target.value)}
				placeholder="Search language"
				className="h-10 border-[var(--lilac-border)] bg-[var(--lilac-card-muted)]"
				aria-label={`${label} search`}
				data-testid={`${testId}-search`}
			/>
			<ScrollArea className="h-44 rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)]">
				<div className="p-1">
					{filteredLanguageList.map(languageOption => {
						const isActive = value === languageOption.code
						return (
							<button
								key={`${label}-${languageOption.code}`}
								type="button"
								onClick={() => onChange(languageOption.code)}
								className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
									isActive
										? 'bg-[var(--lilac-brand-primary)] text-[var(--lilac-brand-primary-foreground)]'
										: 'text-[var(--lilac-ink)] hover:bg-[var(--lilac-card)]'
								}`}
								data-testid={`${testId}-option-${languageOption.code.toLowerCase()}`}
							>
								<span>{languageOption.label}</span>
								<span className={isActive ? 'opacity-90' : 'text-[var(--lilac-ink-muted)]'}>
									{languageOption.code}
								</span>
							</button>
						)
					})}
				</div>
			</ScrollArea>

			<div className="flex items-center gap-2">
				<Input
					value={customCodeValue}
					onChange={event => onCustomCodeValueChange(event.target.value)}
					onKeyDown={event => {
						if (event.key !== 'Enter') return
						event.preventDefault()
						applyCustomCode()
					}}
					placeholder="Any language code (e.g. uk, yue, pt-BR)"
					className="h-10 border-[var(--lilac-border)] bg-[var(--lilac-card-muted)]"
					aria-label={`${label} custom language code`}
				/>
				<Button type="button" variant="outline" onClick={applyCustomCode} className="h-10">
					Apply
				</Button>
			</div>
		</div>
	)
}

type LanguagePickerContentProps = {
	myLanguageCodeDraft: string
	onMyLanguageCodeDraftChange: (value: string) => void
	onTranslateToLanguageCodeDraftChange: (value: string) => void
	setTranslateSettings: (value: { myLanguageCode: string; translateToLanguageCode: string }) => void
	translateSettings: { myLanguageCode: string; translateToLanguageCode: string }
	translateToLanguageCodeDraft: string
}

function LanguagePickerContent({
	myLanguageCodeDraft,
	onMyLanguageCodeDraftChange,
	onTranslateToLanguageCodeDraftChange,
	setTranslateSettings,
	translateSettings,
	translateToLanguageCodeDraft
}: LanguagePickerContentProps) {
	function updateMyLanguage(nextLanguageCode: string): void {
		const resolvedMyLanguageCode = resolveLanguageCode(
			nextLanguageCode,
			translateSettings.myLanguageCode
		)
		let resolvedTranslateToLanguageCode = translateSettings.translateToLanguageCode
		if (resolvedMyLanguageCode === resolvedTranslateToLanguageCode) {
			resolvedTranslateToLanguageCode = translateSettings.myLanguageCode
		}
		setTranslateSettings({
			myLanguageCode: resolvedMyLanguageCode,
			translateToLanguageCode: resolvedTranslateToLanguageCode
		})
	}

	function updateTranslateToLanguage(nextLanguageCode: string): void {
		const resolvedTranslateToLanguageCode = resolveLanguageCode(
			nextLanguageCode,
			translateSettings.translateToLanguageCode
		)
		let resolvedMyLanguageCode = translateSettings.myLanguageCode
		if (resolvedMyLanguageCode === resolvedTranslateToLanguageCode) {
			resolvedMyLanguageCode = translateSettings.translateToLanguageCode
		}
		setTranslateSettings({
			myLanguageCode: resolvedMyLanguageCode,
			translateToLanguageCode: resolvedTranslateToLanguageCode
		})
	}

	return (
		<div className="space-y-4">
			<LanguagePickerField
				customCodeValue={myLanguageCodeDraft}
				label="I Speak"
				onChange={updateMyLanguage}
				onCustomCodeValueChange={onMyLanguageCodeDraftChange}
				testId="translate-primary-language"
				value={translateSettings.myLanguageCode}
			/>
			<LanguagePickerField
				customCodeValue={translateToLanguageCodeDraft}
				label="Translate To"
				onChange={updateTranslateToLanguage}
				onCustomCodeValueChange={onTranslateToLanguageCodeDraftChange}
				testId="translate-secondary-language"
				value={translateSettings.translateToLanguageCode}
			/>
		</div>
	)
}

export default function TranslateMode() {
	const {
		getDirectionColor,
		setTranslateSettings,
		submitTranslateTextInput,
		translateCards,
		translateSettings
	} = useLilacModeRuntime()

	const [draftMessage, setDraftMessage] = useState('')
	const [myLanguageCodeDraft, setMyLanguageCodeDraft] = useState(translateSettings.myLanguageCode)
	const [translateToLanguageCodeDraft, setTranslateToLanguageCodeDraft] = useState(
		translateSettings.translateToLanguageCode
	)
	const stayPinnedToBottomRef = useRef(true)
	const transcriptScrollAreaRef = useRef<HTMLDivElement | null>(null)
	const transcriptViewportRef = useRef<HTMLDivElement | null>(null)
	const translateCardCount = translateCards.length

	useEffect(() => {
		setMyLanguageCodeDraft(translateSettings.myLanguageCode)
	}, [translateSettings.myLanguageCode])

	useEffect(() => {
		setTranslateToLanguageCodeDraft(translateSettings.translateToLanguageCode)
	}, [translateSettings.translateToLanguageCode])

	useEffect(() => {
		const rootElement = transcriptScrollAreaRef.current
		if (!rootElement) return
		const foundViewportElement = rootElement.querySelector(
			'[data-radix-scroll-area-viewport]'
		) as HTMLDivElement | null
		if (!foundViewportElement) return
		const viewportElement = foundViewportElement

		transcriptViewportRef.current = viewportElement

		function handleScroll(): void {
			const distanceFromBottom =
				viewportElement.scrollHeight - viewportElement.scrollTop - viewportElement.clientHeight
			stayPinnedToBottomRef.current = distanceFromBottom < 140
		}

		viewportElement.addEventListener('scroll', handleScroll)
		handleScroll()
		return () => viewportElement.removeEventListener('scroll', handleScroll)
	}, [])

	useEffect(() => {
		if (translateCardCount === 0) return
		if (!stayPinnedToBottomRef.current) return
		const viewportElement = transcriptViewportRef.current
		if (!viewportElement) return
		viewportElement.scrollTo({ behavior: 'auto', top: viewportElement.scrollHeight })
	}, [translateCardCount])

	function submitMessage(): void {
		const normalizedMessage = draftMessage.trim()
		if (!normalizedMessage) return
		submitTranslateTextInput(normalizedMessage)
		setDraftMessage('')
	}

	function swapLanguages(): void {
		setTranslateSettings({
			myLanguageCode: translateSettings.translateToLanguageCode,
			translateToLanguageCode: translateSettings.myLanguageCode
		})
	}

	const pairSummary = `${resolveLanguageLabel(translateSettings.myLanguageCode)} ↔ ${resolveLanguageLabel(
		translateSettings.translateToLanguageCode
	)}`

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
			<div className="flex items-center justify-between rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] px-3 py-2">
				<div className="min-w-0">
					<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
						Language Pair
					</div>
					<p className="truncate font-medium text-[var(--lilac-ink)] text-sm">{pairSummary}</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={swapLanguages}
						className="h-9 rounded-full px-3"
						aria-label="Swap language pair"
					>
						<ArrowRightLeft className="h-4 w-4" />
					</Button>

					<Dialog>
						<DialogTrigger asChild>
							<Button
								type="button"
								variant="outline"
								className="hidden h-9 rounded-full px-3 text-[11px] uppercase tracking-[0.12em] sm:inline-flex"
								data-testid="translate-language-picker-open-desktop"
							>
								Languages
							</Button>
						</DialogTrigger>
						<DialogContent className="max-h-[88dvh] overflow-hidden border-[var(--lilac-border)] bg-[var(--lilac-surface)] p-0 sm:max-w-xl">
							<DialogHeader className="border-[var(--lilac-border)] border-b px-5 pt-5 pb-4">
								<DialogTitle className="text-[var(--lilac-ink)]">Languages</DialogTitle>
								<DialogDescription className="text-[var(--lilac-ink-muted)]">
									Pick from presets or enter any valid language code.
								</DialogDescription>
							</DialogHeader>
							<div className="overflow-y-auto px-5 py-4">
								<LanguagePickerContent
									myLanguageCodeDraft={myLanguageCodeDraft}
									onMyLanguageCodeDraftChange={setMyLanguageCodeDraft}
									onTranslateToLanguageCodeDraftChange={setTranslateToLanguageCodeDraft}
									setTranslateSettings={setTranslateSettings}
									translateSettings={translateSettings}
									translateToLanguageCodeDraft={translateToLanguageCodeDraft}
								/>
							</div>
						</DialogContent>
					</Dialog>

					<Sheet>
						<SheetTrigger asChild>
							<Button
								type="button"
								variant="outline"
								className="h-9 rounded-full px-3 text-[11px] uppercase tracking-[0.12em] sm:hidden"
								data-testid="translate-language-picker-open-mobile"
							>
								Languages
							</Button>
						</SheetTrigger>
						<SheetContent
							side="bottom"
							className="max-h-[90dvh] overflow-y-auto rounded-t-2xl border-[var(--lilac-border)] bg-[var(--lilac-surface)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
						>
							<SheetHeader className="pb-2 text-left">
								<SheetTitle className="text-[var(--lilac-ink)]">Languages</SheetTitle>
								<SheetDescription className="text-[var(--lilac-ink-muted)]">
									Pick from presets or enter any valid language code.
								</SheetDescription>
							</SheetHeader>
							<LanguagePickerContent
								myLanguageCodeDraft={myLanguageCodeDraft}
								onMyLanguageCodeDraftChange={setMyLanguageCodeDraft}
								onTranslateToLanguageCodeDraftChange={setTranslateToLanguageCodeDraft}
								setTranslateSettings={setTranslateSettings}
								translateSettings={translateSettings}
								translateToLanguageCodeDraft={translateToLanguageCodeDraft}
							/>
						</SheetContent>
					</Sheet>
				</div>
			</div>

			<ScrollArea
				ref={transcriptScrollAreaRef}
				data-testid="translate-card-list"
				className="min-h-0 flex-1 rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card)]"
			>
				<div className="flex flex-col gap-3 p-3 sm:p-4">
					{translateCards.length ? (
						translateCards.map(card => {
							const routeLabel = `${resolveLanguageLabel(card.sourceLanguageCode)} → ${resolveLanguageLabel(
								card.targetLanguageCode
							)}`
							const finalTranslationText = card.translatedText.trim()
							const draftTranslationText = card.draftTranslatedText?.trim() ?? ''
							const isStreamingDraft =
								card.renderState === 'draft' || card.status === 'streaming' || card.status === 'translating'
							const translationText = finalTranslationText
								? finalTranslationText
								: draftTranslationText
									? draftTranslationText
									: card.status === 'error'
										? (card.errorMessage ?? 'Translation failed.')
										: 'Listening…'
							return (
								<article
									key={card.id}
									data-testid={`translate-card-${card.id}`}
									data-render-state={card.renderState}
									className="rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] px-3 py-2"
								>
									<div className="mb-0.5 flex items-center justify-between gap-2">
										<p
											className="font-semibold text-[0.74rem] tracking-[0.03em]"
											style={{ color: getDirectionColor(card.direction) }}
										>
											{routeLabel}
										</p>
										{isStreamingDraft ? (
											<div className="inline-flex items-center gap-1">
												<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--lilac-direction-secondary)]" />
												<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--lilac-direction-secondary)] [animation-delay:120ms]" />
												<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--lilac-direction-secondary)] [animation-delay:240ms]" />
											</div>
										) : null}
									</div>

									<p
										className="whitespace-pre-wrap break-words text-[1.1rem] text-[var(--lilac-ink)] leading-snug sm:text-[1.2rem]"
										data-testid={`translate-card-target-${card.id}`}
									>
										{translationText}
									</p>
									<p
										className="mt-0.5 whitespace-pre-wrap break-words text-[0.78rem] text-[var(--lilac-ink-muted)] leading-relaxed"
										data-testid={`translate-card-source-${card.id}`}
									>
										{card.sourceText.trim() || '…'}
									</p>
								</article>
							)
						})
					) : (
						<div
							className="flex min-h-44 items-center justify-center px-4 py-6 text-[var(--lilac-ink-muted)] text-sm"
							data-testid="translate-empty-state"
						>
							Translated subtitles appear here.
						</div>
					)}
				</div>
			</ScrollArea>

			<form
				className="rounded-xl border border-[var(--lilac-border)] bg-[color-mix(in_oklab,var(--lilac-card)_84%,transparent)] p-2"
				onSubmit={event => {
					event.preventDefault()
					submitMessage()
				}}
			>
				<div className="flex items-end gap-2">
					<Textarea
						value={draftMessage}
						data-testid="translate-text-input"
						onChange={event => setDraftMessage(event.target.value)}
						onKeyDown={event => {
							if (event.key !== 'Enter') return
							if (event.shiftKey) return
							event.preventDefault()
							submitMessage()
						}}
						placeholder="Type text to translate"
						aria-label="Translate text input"
						className="max-h-36 min-h-11 resize-none border-[var(--lilac-border)] bg-[var(--lilac-card-muted)]"
					/>
					<Button
						type="submit"
						data-testid="translate-text-send"
						disabled={!draftMessage.trim()}
						className="h-11 rounded-xl px-4 font-semibold text-xs uppercase tracking-[0.1em]"
					>
						Send
					</Button>
				</div>
				<p className="pt-2 text-[var(--lilac-ink-muted)] text-xs">
					Enter to send, Shift+Enter for newline.
				</p>
			</form>
		</div>
	)
}
