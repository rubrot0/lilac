'use client'

import { useEffect, useRef, useState } from 'react'

import { useLilacModeRuntime } from '@/realtime/modeRuntimeStore'

export default function ChatMode() {
	const {
		chatInstructions,
		chatTranscripts,
		chatTurnDelaySeconds,
		remoteAudioStream,
		setChatInstructions,
		setChatTurnDelaySeconds
	} = useLilacModeRuntime()
	const [draftInstructions, setDraftInstructions] = useState(chatInstructions)
	const [saveMessage, setSaveMessage] = useState('')
	const transcriptListRef = useRef<HTMLDivElement | null>(null)
	const transcriptBottomRef = useRef<HTMLDivElement | null>(null)
	const stayPinnedToBottomRef = useRef(true)
	const playbackAudioElementRef = useRef<HTMLAudioElement | null>(null)

	useEffect(() => {
		setDraftInstructions(chatInstructions)
	}, [chatInstructions])

	useEffect(() => {
		if (!saveMessage) return
		const timeoutId = window.setTimeout(() => setSaveMessage(''), 1600)
		return () => {
			window.clearTimeout(timeoutId)
		}
	}, [saveMessage])

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
		void chatTranscripts
		transcriptBottomRef.current?.scrollIntoView({ behavior: 'auto' })
	}, [chatTranscripts])

	useEffect(() => {
		if (!playbackAudioElementRef.current) {
			playbackAudioElementRef.current = new Audio()
			playbackAudioElementRef.current.autoplay = true
		}
		const playbackAudioElement = playbackAudioElementRef.current
		if (!playbackAudioElement) return
		playbackAudioElement.srcObject = remoteAudioStream
		if (remoteAudioStream) {
			void playbackAudioElement.play().catch(() => {})
		}
		return () => {
			playbackAudioElement.pause()
			playbackAudioElement.srcObject = null
		}
	}, [remoteAudioStream])

	return (
		<div className="flex w-full max-w-5xl flex-col gap-4">
			<div
				ref={transcriptListRef}
				className="h-[54dvh] overflow-y-auto rounded-3xl border border-white/25 bg-[var(--lilac-elevated)]/80 p-4 shadow-xl backdrop-blur"
			>
				{chatTranscripts.length ? (
					<div className="flex flex-col gap-3">
						{chatTranscripts.map(message => {
							const isUser = message.role === 'user'
							const bubbleBaseClasses =
								'max-w-[94%] whitespace-pre-wrap rounded-3xl px-4 py-3 text-sm leading-relaxed shadow-sm'
							const bubbleClasses = isUser
								? `${bubbleBaseClasses} self-end bg-[var(--lilac-ink)] text-[var(--lilac-surface)]`
								: `${bubbleBaseClasses} self-start border border-white/30 bg-white/80 text-[var(--lilac-ink)] dark:bg-white/12`
							const label = isUser ? 'You' : 'Lilac'
							return (
								<div key={message.id} className="flex flex-col gap-1">
									<div
										className={`px-1 font-semibold text-[10px] uppercase tracking-[0.16em] ${
											isUser ? 'text-right text-[var(--lilac-ink-muted)]' : 'text-[var(--lilac-ink-muted)]'
										}`}
									>
										{label}
										{message.status === 'streaming' ? <span className="ml-1 opacity-60">•</span> : null}
									</div>
									<div className={bubbleClasses}>{message.text.trim() || '…'}</div>
								</div>
							)
						})}
						<div ref={transcriptBottomRef} />
					</div>
				) : (
					<div className="flex h-full items-center justify-center text-[var(--lilac-ink-muted)] text-sm">
						Speak to start chatting with Lilac.
					</div>
				)}
			</div>

			<div className="grid gap-4 md:grid-cols-2">
				<div className="rounded-3xl border border-white/25 bg-[var(--lilac-elevated)]/80 p-4 shadow-lg backdrop-blur">
					<div className="mb-2 font-semibold text-[var(--lilac-ink-muted)] text-sm uppercase tracking-[0.12em]">
						Instructions
					</div>
					<textarea
						className="h-36 w-full resize-none rounded-2xl border border-white/30 bg-white/80 px-3 py-2 text-[var(--lilac-ink)] text-sm outline-none transition focus:border-white/60 dark:bg-white/10"
						onChange={event => setDraftInstructions(event.target.value)}
						value={draftInstructions}
					/>
					<div className="mt-3 flex items-center justify-end gap-2">
						<button
							type="button"
							className="cursor-pointer rounded-full px-3 py-2 font-semibold text-[var(--lilac-ink-muted)] text-xs uppercase tracking-[0.12em] transition hover:bg-white/40"
							onClick={() => setDraftInstructions(chatInstructions)}
						>
							Reset
						</button>
						<button
							type="button"
							className="cursor-pointer rounded-full bg-[var(--lilac-ink)] px-4 py-2 font-semibold text-[var(--lilac-surface)] text-xs uppercase tracking-[0.12em] transition hover:shadow"
							onClick={() => {
								setChatInstructions(draftInstructions.trim() || defaultChatInstructions)
								setSaveMessage('Saved')
							}}
						>
							Save
						</button>
					</div>
					{saveMessage ? (
						<output className="mt-2 block text-[var(--lilac-ink-muted)] text-xs" aria-live="polite">
							{saveMessage}
						</output>
					) : null}
				</div>

				<div className="rounded-3xl border border-white/25 bg-[var(--lilac-elevated)]/80 p-4 shadow-lg backdrop-blur">
					<div className="mb-2 font-semibold text-[var(--lilac-ink-muted)] text-sm uppercase tracking-[0.12em]">
						End-of-speech delay
					</div>
					<p className="mb-4 text-[var(--lilac-ink-muted)] text-sm">
						Increase this if Lilac responds before you finish speaking.
					</p>
					<input
						className="lilac-range"
						max={6}
						min={0.2}
						onChange={event => setChatTurnDelaySeconds(Number.parseFloat(event.target.value))}
						step={0.1}
						type="range"
						value={chatTurnDelaySeconds}
					/>
					<div className="mt-3 flex items-center justify-between text-sm">
						<span className="text-[var(--lilac-ink-muted)]">Delay</span>
						<span className="font-semibold text-[var(--lilac-ink)]">
							{chatTurnDelaySeconds.toFixed(1)}s
						</span>
					</div>
				</div>
			</div>
		</div>
	)
}

const defaultChatInstructions =
	'You are Lilac. Help users communicate across languages. Keep answers concise, faithful, and practical.'
