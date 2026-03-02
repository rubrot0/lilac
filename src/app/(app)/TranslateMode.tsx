'use client'

import { useEffect, useRef } from 'react'

import { useLilacModeRuntime } from '@/realtime/modeRuntimeStore'
import { languageOptions } from '@/realtime/sessionTypes'

export default function TranslateMode() {
	const { getDirectionColor, setTranslateSettings, translateCards, translateSettings } =
		useLilacModeRuntime()
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
			stayPinnedToBottomRef.current = distanceFromBottom < 120
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

	return (
		<div className="flex w-full max-w-5xl flex-col gap-4">
			<div
				ref={transcriptListRef}
				className="h-[58dvh] overflow-y-auto rounded-3xl border border-white/25 bg-[var(--lilac-elevated)]/80 p-4 shadow-xl backdrop-blur"
			>
				{translateCards.length ? (
					<div className="flex flex-col gap-3">
						{translateCards.map(card => (
							<article
								key={card.id}
								className="rounded-2xl border border-white/25 bg-white/70 p-3 shadow-sm dark:bg-white/10"
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
									<span className="font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]">
										{card.status}
									</span>
								</div>
								<div className="grid gap-2 md:grid-cols-2">
									<div className="rounded-xl bg-[var(--lilac-surface)]/70 px-3 py-2">
										<div className="mb-1 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
											{card.sourceLanguageCode}
										</div>
										<p className="whitespace-pre-wrap text-[var(--lilac-ink)] text-sm leading-relaxed">
											{card.sourceText.trim() || '…'}
										</p>
									</div>
									<div className="rounded-xl bg-[var(--lilac-surface)]/70 px-3 py-2">
										<div className="mb-1 font-semibold text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
											{card.targetLanguageCode}
										</div>
										<p className="whitespace-pre-wrap text-[var(--lilac-ink)] text-sm leading-relaxed">
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
					<div className="flex h-full items-center justify-center text-[var(--lilac-ink-muted)] text-sm">
						Live pairwise translation cards will appear here.
					</div>
				)}
			</div>

			<div className="grid gap-3 rounded-3xl border border-white/25 bg-[var(--lilac-elevated)]/80 p-4 shadow-lg backdrop-blur md:grid-cols-2">
				<label className="flex flex-col gap-2">
					<span className="font-semibold text-[var(--lilac-ink-muted)] text-xs uppercase tracking-[0.12em]">
						Primary language
					</span>
					<select
						className="rounded-2xl border border-white/30 bg-white/80 px-3 py-2 text-[var(--lilac-ink)] text-sm outline-none transition focus:border-white/60"
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
						className="rounded-2xl border border-white/30 bg-white/80 px-3 py-2 text-[var(--lilac-ink)] text-sm outline-none transition focus:border-white/60"
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
			</div>
		</div>
	)
}
