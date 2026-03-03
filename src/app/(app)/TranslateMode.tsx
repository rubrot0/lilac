'use client'

import { useEffect, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
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
	const stayPinnedToBottomRef = useRef(true)
	const transcriptScrollAreaRef = useRef<HTMLDivElement | null>(null)
	const transcriptViewportRef = useRef<HTMLDivElement | null>(null)
	const translateCardCount = translateCards.length

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

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="grid gap-3 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-3 sm:grid-cols-2">
				<div className="space-y-2">
					<span className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
						Primary language
					</span>
					<Select
						value={translateSettings.primaryLanguageCode}
						onValueChange={nextPrimary => {
							const nextSecondary =
								nextPrimary === translateSettings.secondaryLanguageCode
									? translateSettings.primaryLanguageCode
									: translateSettings.secondaryLanguageCode
							setTranslateSettings({
								primaryLanguageCode: nextPrimary,
								secondaryLanguageCode: nextSecondary
							})
						}}
					>
						<SelectTrigger
							className="h-11 border-[var(--lilac-border)] bg-[var(--lilac-card-muted)]"
							data-testid="translate-primary-language"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{languageOptions.map(option => (
								<SelectItem key={option.code} value={option.code}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="space-y-2">
					<span className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
						Secondary language
					</span>
					<Select
						value={translateSettings.secondaryLanguageCode}
						onValueChange={nextSecondary => {
							const nextPrimary =
								nextSecondary === translateSettings.primaryLanguageCode
									? translateSettings.secondaryLanguageCode
									: translateSettings.primaryLanguageCode
							setTranslateSettings({
								primaryLanguageCode: nextPrimary,
								secondaryLanguageCode: nextSecondary
							})
						}}
					>
						<SelectTrigger
							className="h-11 border-[var(--lilac-border)] bg-[var(--lilac-card-muted)]"
							data-testid="translate-secondary-language"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{languageOptions.map(option => (
								<SelectItem key={option.code} value={option.code}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<p className="text-[var(--lilac-ink-muted)] text-xs sm:col-span-2">
					Voice input is {voiceInputEnabled ? 'enabled' : 'disabled'} globally.
				</p>
			</div>

			<ScrollArea
				ref={transcriptScrollAreaRef}
				data-testid="translate-card-list"
				className="min-h-0 flex-1 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)]"
			>
				{translateCards.length ? (
					<div className="flex flex-col gap-3 p-3 sm:p-4">
						{translateCards.map(card => (
							<article
								key={card.id}
								data-testid={`translate-card-${card.id}`}
								className="rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] p-3"
							>
								<div className="mb-2 flex items-center justify-between gap-2">
									<Badge
										className="rounded-full border-none px-2 py-1 font-semibold text-[10px] text-white uppercase tracking-[0.12em]"
										style={{ backgroundColor: getDirectionColor(card.direction) }}
									>
										{card.direction.replaceAll('_', ' ')}
									</Badge>
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
					</div>
				) : (
					<div
						className="flex min-h-56 items-center justify-center px-4 py-6 text-[var(--lilac-ink-muted)] text-sm"
						data-testid="translate-empty-state"
					>
						Live translation cards appear here.
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
				<div className="flex items-center gap-2">
					<Input
						type="text"
						value={draftMessage}
						data-testid="translate-text-input"
						onChange={event => setDraftMessage(event.target.value)}
						placeholder="Type text to translate"
						className="h-11 border-[var(--lilac-border)] bg-[var(--lilac-card-muted)]"
					/>
					<Button
						type="submit"
						data-testid="translate-text-send"
						disabled={!draftMessage.trim()}
						className="h-11 rounded-xl bg-[var(--lilac-ink)] px-4 font-semibold text-[var(--lilac-surface)] text-xs uppercase tracking-[0.1em]"
					>
						Send
					</Button>
				</div>
			</form>
		</div>
	)
}
