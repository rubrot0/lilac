'use client'

import { useEffect, useRef, useState } from 'react'

import { useLilacModeRuntime } from '@/realtime/modeRuntimeStore'
import { languageOptions } from '@/realtime/sessionTypes'

export default function TranslateMode() {
	const {
		getDirectionColor,
		setTranslateSettings,
		submitTranslateTextInput,
		translateCards,
		translateSettings,
		voiceInputEnabled
	} = useLilacModeRuntime()
	const [draftMessage, setDraftMessage] = useState('')
	const transcriptListRef = useRef<HTMLDivElement | null>(null)
	const transcriptBottomRef = useRef<HTMLDivElement | null>(null)
	const stayPinnedToBottomRef = useRef(true)

	useEffect(() => {
		const transcriptListElement = transcriptListRef.current
		if (!transcriptListElement) return
		const activeTranscriptListElement = transcriptListElement

		function onScroll(): void {
			const distanceFromBottom =
				activeTranscriptListElement.scrollHeight -
				activeTranscriptListElement.scrollTop -
				activeTranscriptListElement.clientHeight
			stayPinnedToBottomRef.current = distanceFromBottom < 140
		}

		activeTranscriptListElement.addEventListener('scroll', onScroll)
		onScroll()
		return () => {
			activeTranscriptListElement.removeEventListener('scroll', onScroll)
		}
	}, [])

	useEffect(() => {
		if (!stayPinnedToBottomRef.current) return
		void translateCards
		transcriptBottomRef.current?.scrollIntoView({ behavior: 'auto' })
	}, [translateCards])

	function submitMessage(): void {
		const normalizedMessage = draftMessage.trim()
		if (!normalizedMessage) return
		submitTranslateTextInput(normalizedMessage)
		setDraftMessage('')
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div
				ref={transcriptListRef}
				data-testid="translate-card-list"
				className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-3 sm:p-4"
			>
				{translateCards.length ? (
					<div className="flex flex-col gap-3">
						{translateCards.map(card => (
							<article
								key={card.id}
								data-testid={`translate-card-${card.id}`}
								className="rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] p-3"
							>
								<div className="mb-2 flex items-center justify-between gap-2">
									<span
										className="rounded-full px-2 py-1 font-semibold text-[10px] uppercase tracking-[0.12em]"
										style={{
											backgroundColor: getDirectionColor(card.direction),
											color: 'white'
										}}
									>
										{card.direction.replaceAll('_', ' ')}
									</span>
									<div className="flex items-center gap-2">
										<span className="font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]">
											{card.inputOrigin}
										</span>
										<span
											className="font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]"
											data-testid={`translate-card-status-${card.id}`}
										>
											{card.status}
										</span>
									</div>
								</div>
								<div className="grid gap-2 sm:grid-cols-2">
									<div className="rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] px-3 py-2">
										<div className="mb-1 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
											{card.sourceLanguageCode}
										</div>
										<p
											className="whitespace-pre-wrap text-[var(--lilac-ink)] text-sm leading-relaxed"
											data-testid={`translate-card-source-${card.id}`}
										>
											{card.sourceText.trim() || '…'}
										</p>
									</div>
									<div className="rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] px-3 py-2">
										<div className="mb-1 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
											{card.targetLanguageCode}
										</div>
										<p
											className="whitespace-pre-wrap text-[var(--lilac-ink)] text-sm leading-relaxed"
											data-testid={`translate-card-target-${card.id}`}
										>
											{card.translatedText.trim() ||
												(card.status === 'error' ? card.errorMessage : 'Translating…')}
										</p>
									</div>
								</div>
							</article>
						))}
						<div ref={transcriptBottomRef} />
					</div>
				) : (
					<div
						className="flex h-full items-center justify-center text-[var(--lilac-ink-muted)] text-sm"
						data-testid="translate-empty-state"
					>
						Live translation cards appear here.
					</div>
				)}
			</div>

			<div className="grid gap-3 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-3 sm:grid-cols-2">
				<label className="flex flex-col gap-2">
					<span className="font-semibold text-[var(--lilac-ink-muted)] text-xs uppercase tracking-[0.12em]">
						Primary language
					</span>
					<select
						className="rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] px-3 py-2 text-[var(--lilac-ink)] text-sm outline-none transition focus:border-[var(--lilac-border-strong)]"
						data-testid="translate-primary-language"
						onChange={event => {
							const nextPrimary = event.target.value
							const nextSecondary =
								nextPrimary === translateSettings.secondaryLanguageCode
									? translateSettings.primaryLanguageCode
									: translateSettings.secondaryLanguageCode
							setTranslateSettings({
								primaryLanguageCode: nextPrimary,
								secondaryLanguageCode: nextSecondary
							})
						}}
						value={translateSettings.primaryLanguageCode}
					>
						{languageOptions.map(option => (
							<option key={option.code} value={option.code}>
								{option.label}
							</option>
						))}
					</select>
				</label>

				<label className="flex flex-col gap-2">
					<span className="font-semibold text-[var(--lilac-ink-muted)] text-xs uppercase tracking-[0.12em]">
						Secondary language
					</span>
					<select
						className="rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] px-3 py-2 text-[var(--lilac-ink)] text-sm outline-none transition focus:border-[var(--lilac-border-strong)]"
						data-testid="translate-secondary-language"
						onChange={event => {
							const nextSecondary = event.target.value
							const nextPrimary =
								nextSecondary === translateSettings.primaryLanguageCode
									? translateSettings.secondaryLanguageCode
									: translateSettings.primaryLanguageCode
							setTranslateSettings({
								primaryLanguageCode: nextPrimary,
								secondaryLanguageCode: nextSecondary
							})
						}}
						value={translateSettings.secondaryLanguageCode}
					>
						{languageOptions.map(option => (
							<option key={option.code} value={option.code}>
								{option.label}
							</option>
						))}
					</select>
				</label>

				<div className="sm:col-span-2">
					<p className="text-[var(--lilac-ink-muted)] text-xs">
						Voice input is {voiceInputEnabled ? 'enabled' : 'disabled'} globally.
					</p>
				</div>
			</div>

			<form
				className="sticky bottom-0 z-10 rounded-2xl border border-[var(--lilac-border)] bg-[color-mix(in_oklab,var(--lilac-card)_84%,transparent)] p-2 backdrop-blur"
				onSubmit={event => {
					event.preventDefault()
					submitMessage()
				}}
			>
				<div className="flex items-center gap-2">
					<input
						type="text"
						value={draftMessage}
						data-testid="translate-text-input"
						onChange={event => setDraftMessage(event.target.value)}
						placeholder="Type text to translate"
						className="h-11 w-full rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] px-3 text-[var(--lilac-ink)] text-sm outline-none transition focus:border-[var(--lilac-border-strong)]"
					/>
					<button
						type="submit"
						data-testid="translate-text-send"
						className="h-11 cursor-pointer rounded-xl bg-[var(--lilac-ink)] px-4 font-semibold text-[var(--lilac-surface)] text-xs uppercase tracking-[0.1em] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
						disabled={!draftMessage.trim()}
					>
						Send
					</button>
				</div>
			</form>
		</div>
	)
}
