'use client'

import { ArrowRightLeft } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue
} from '@/components/ui/select'
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

type LanguageSelectProps = {
	customCodeDraft: string
	label: string
	onChange: (nextLanguageCode: string) => void
	onCustomCodeDraftChange: (value: string) => void
	testId: string
	value: string
}

function LanguageSelect({
	customCodeDraft,
	label,
	onChange,
	onCustomCodeDraftChange,
	testId,
	value
}: LanguageSelectProps) {
	const knownCodeSet = useMemo(
		() => new Set(orderedLanguageList.map(languageOption => languageOption.code)),
		[]
	)
	const selectValue = knownCodeSet.has(value) ? value : '__custom__'

	function applyCustomCodeDraft(): void {
		const resolvedLanguageCode = resolveLanguageCode(customCodeDraft, value)
		onChange(resolvedLanguageCode)
		onCustomCodeDraftChange(resolvedLanguageCode)
	}

	return (
		<div className="space-y-2">
			<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
				{label}
			</div>
			<Select
				value={selectValue}
				onValueChange={nextValue => {
					if (nextValue === '__custom__') return
					onChange(nextValue)
				}}
			>
				<SelectTrigger
					className="h-11 border-[var(--lilac-border)] bg-[var(--lilac-card-muted)]"
					data-testid={testId}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent className="max-h-[50dvh]">
					{orderedLanguageList.map(languageOption => (
						<SelectItem key={languageOption.code} value={languageOption.code}>
							{languageOption.label}
						</SelectItem>
					))}
					<SelectItem value="__custom__">Custom code</SelectItem>
				</SelectContent>
			</Select>
			<Input
				value={customCodeDraft}
				onChange={event => onCustomCodeDraftChange(event.target.value)}
				onBlur={applyCustomCodeDraft}
				onKeyDown={event => {
					if (event.key !== 'Enter') return
					event.preventDefault()
					applyCustomCodeDraft()
				}}
				placeholder="Any language code (e.g., uk, yue, pt-BR)"
				className="h-10 border-[var(--lilac-border)] bg-[var(--lilac-card-muted)]"
				aria-label={`${label} custom language code`}
			/>
		</div>
	)
}

export default function TranslateMode() {
	const {
		getDirectionColor,
		liveSubtitleState,
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
			<div className="space-y-3 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-3">
				<div className="flex items-center justify-between gap-3">
					<div>
						<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
							Language Pair
						</div>
						<p className="font-medium text-[var(--lilac-ink)] text-sm">{pairSummary}</p>
					</div>
					<Button
						type="button"
						variant="outline"
						onClick={swapLanguages}
						className="rounded-full border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] px-3"
						aria-label="Swap language pair"
					>
						<ArrowRightLeft className="h-4 w-4" />
					</Button>
				</div>

				<div className="grid gap-3 sm:grid-cols-2">
					<LanguageSelect
						customCodeDraft={myLanguageCodeDraft}
						label="I Speak"
						onChange={updateMyLanguage}
						onCustomCodeDraftChange={setMyLanguageCodeDraft}
						testId="translate-primary-language"
						value={translateSettings.myLanguageCode}
					/>
					<LanguageSelect
						customCodeDraft={translateToLanguageCodeDraft}
						label="Translate To"
						onChange={updateTranslateToLanguage}
						onCustomCodeDraftChange={setTranslateToLanguageCodeDraft}
						testId="translate-secondary-language"
						value={translateSettings.translateToLanguageCode}
					/>
				</div>
			</div>

			<div
				className="rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] px-3 py-2"
				data-testid="translate-live-subtitle-rail"
				aria-live="polite"
			>
				<div className="flex items-center gap-2 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]">
					<span
						className={`inline-flex h-2 w-2 rounded-full ${
							liveSubtitleState.isListening
								? 'animate-pulse bg-[var(--lilac-direction-secondary)]'
								: 'bg-[var(--lilac-border-strong)]'
						}`}
					/>
					{liveSubtitleState.isListening ? 'Listening…' : 'Listening paused'}
				</div>
				<p className="min-h-6 whitespace-pre-wrap break-words pt-1 text-[var(--lilac-ink)] text-sm">
					{liveSubtitleState.text || 'Live subtitles appear here while people speak.'}
				</p>
			</div>

			<ScrollArea
				ref={transcriptScrollAreaRef}
				data-testid="translate-card-list"
				className="min-h-0 flex-1 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)]"
			>
				{translateCards.length ? (
					<div className="flex flex-col gap-3 p-3 sm:p-4">
						{translateCards.map(card => {
							const routeLabel = `${resolveLanguageLabel(card.sourceLanguageCode)} -> ${resolveLanguageLabel(
								card.targetLanguageCode
							)}`
							const isTranslating = card.status === 'streaming' || card.status === 'translating'
							return (
								<article
									key={card.id}
									data-testid={`translate-card-${card.id}`}
									className="rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] p-3"
								>
									<div className="mb-2 flex items-center justify-between gap-2">
										<div
											className="font-semibold text-xs tracking-[0.06em]"
											style={{ color: getDirectionColor(card.direction) }}
										>
											{routeLabel}
										</div>
										{isTranslating ? (
											<div className="inline-flex items-center gap-1">
												<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--lilac-direction-secondary)]" />
												<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--lilac-direction-secondary)] [animation-delay:120ms]" />
												<span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--lilac-direction-secondary)] [animation-delay:240ms]" />
											</div>
										) : null}
									</div>

									<div className="space-y-2">
										<div className="rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] px-3 py-2">
											<div className="mb-1 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
												Heard ({resolveLanguageLabel(card.sourceLanguageCode)})
											</div>
											<p
												className="whitespace-pre-wrap break-words text-[var(--lilac-ink)] text-sm leading-relaxed"
												data-testid={`translate-card-source-${card.id}`}
											>
												{card.sourceText.trim() || '…'}
											</p>
										</div>

										<div className="rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] px-3 py-2">
											<div className="mb-1 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
												Translation ({resolveLanguageLabel(card.targetLanguageCode)})
											</div>
											<p
												className="whitespace-pre-wrap break-words text-[var(--lilac-ink)] text-sm leading-relaxed"
												data-testid={`translate-card-target-${card.id}`}
											>
												{card.translatedText.trim() ||
													(card.status === 'error'
														? (card.errorMessage ?? 'Translation failed.')
														: 'Translating…')}
											</p>
										</div>
									</div>
								</article>
							)
						})}
					</div>
				) : (
					<div
						className="flex min-h-56 items-center justify-center px-4 py-6 text-[var(--lilac-ink-muted)] text-sm"
						data-testid="translate-empty-state"
					>
						Translated subtitles appear here.
					</div>
				)}
			</ScrollArea>

			<form
				className="rounded-2xl border border-[var(--lilac-border)] bg-[color-mix(in_oklab,var(--lilac-card)_84%,transparent)] p-2"
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
						className="h-11 rounded-xl bg-[var(--lilac-brand-primary)] px-4 font-semibold text-[var(--lilac-brand-primary-foreground)] text-xs uppercase tracking-[0.1em]"
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
