'use client'

import { useEffect, useRef, useState } from 'react'

import { useLilacModeRuntime } from '@/realtime/modeRuntimeStore'

const defaultChatInstructions =
	'You are Lilac. Help users communicate across languages. Keep answers concise, faithful, and practical.'

export default function ChatMode() {
	const {
		chatInstructions,
		chatSpeechOutputEnabled,
		chatTranscripts,
		chatTurnDelaySeconds,
		remoteAudioStream,
		setChatInstructions,
		setChatSpeechOutputEnabled,
		setChatTurnDelaySeconds,
		submitChatTextInput,
		voiceInputEnabled
	} = useLilacModeRuntime()
	const [draftInstructions, setDraftInstructions] = useState(chatInstructions)
	const [draftMessage, setDraftMessage] = useState('')
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
		playbackAudioElement.srcObject = chatSpeechOutputEnabled ? remoteAudioStream : null
		if (chatSpeechOutputEnabled && remoteAudioStream) {
			void playbackAudioElement.play().catch(() => {})
		}
		return () => {
			playbackAudioElement.pause()
			playbackAudioElement.srcObject = null
		}
	}, [chatSpeechOutputEnabled, remoteAudioStream])

	function submitMessage(): void {
		const normalizedMessage = draftMessage.trim()
		if (!normalizedMessage) return
		submitChatTextInput(normalizedMessage)
		setDraftMessage('')
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div
				ref={transcriptListRef}
				data-testid="chat-transcript-list"
				className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-3 sm:p-4"
			>
				{chatTranscripts.length ? (
					<div className="flex flex-col gap-3">
						{chatTranscripts.map(message => {
							const isUser = message.role === 'user'
							const bubbleBaseClasses =
								'max-w-[92%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed'
							const bubbleClasses = isUser
								? `${bubbleBaseClasses} self-end bg-[var(--lilac-ink)] text-[var(--lilac-surface)]`
								: `${bubbleBaseClasses} self-start border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] text-[var(--lilac-ink)]`
							return (
								<div
									key={message.id}
									className="flex flex-col gap-1"
									data-testid={`chat-message-${message.id}`}
								>
									<div
										className={`px-1 font-semibold text-[10px] uppercase tracking-[0.16em] ${
											isUser ? 'text-right text-[var(--lilac-ink-muted)]' : 'text-[var(--lilac-ink-muted)]'
										}`}
									>
										{isUser ? 'You' : 'Lilac'}
										{message.status === 'streaming' ? <span className="ml-1 opacity-60">•</span> : null}
									</div>
									<div className={bubbleClasses} data-testid={`chat-message-text-${message.id}`}>
										{message.text.trim() || '…'}
									</div>
								</div>
							)
						})}
						<div ref={transcriptBottomRef} />
					</div>
				) : (
					<div
						className="flex h-full items-center justify-center text-[var(--lilac-ink-muted)] text-sm"
						data-testid="chat-empty-state"
					>
						Start with voice or type below.
					</div>
				)}
			</div>

			<div className="grid gap-3 lg:grid-cols-2">
				<div className="rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-3">
					<div className="mb-2 flex items-center justify-between gap-2">
						<div className="font-semibold text-[var(--lilac-ink-muted)] text-xs uppercase tracking-[0.12em]">
							Speech output
						</div>
						<button
							type="button"
							aria-pressed={chatSpeechOutputEnabled}
							data-testid="chat-speech-output-toggle"
							className={`cursor-pointer rounded-lg px-3 py-2 font-semibold text-xs uppercase tracking-[0.1em] transition ${
								chatSpeechOutputEnabled
									? 'bg-[var(--lilac-direction-primary)] text-white'
									: 'bg-[var(--lilac-card-muted)] text-[var(--lilac-ink-muted)]'
							}`}
							onClick={() => setChatSpeechOutputEnabled(!chatSpeechOutputEnabled)}
						>
							{chatSpeechOutputEnabled ? 'On' : 'Off'}
						</button>
					</div>
					<p className="mb-3 text-[var(--lilac-ink-muted)] text-sm">
						Voice input is {voiceInputEnabled ? 'enabled' : 'disabled'} globally.
					</p>

					<div className="mb-2 font-semibold text-[var(--lilac-ink-muted)] text-xs uppercase tracking-[0.12em]">
						End-of-speech delay
					</div>
					<input
						className="lilac-range"
						data-testid="chat-turn-delay-slider"
						max={6}
						min={0.2}
						onChange={event => setChatTurnDelaySeconds(Number.parseFloat(event.target.value))}
						step={0.1}
						type="range"
						value={chatTurnDelaySeconds}
					/>
					<div className="mt-2 flex items-center justify-between text-sm">
						<span className="text-[var(--lilac-ink-muted)]">Delay</span>
						<span className="font-semibold text-[var(--lilac-ink)]">
							{chatTurnDelaySeconds.toFixed(1)}s
						</span>
					</div>
				</div>

				<div className="rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-3">
					<div className="mb-2 font-semibold text-[var(--lilac-ink-muted)] text-xs uppercase tracking-[0.12em]">
						Instructions
					</div>
					<textarea
						className="h-28 w-full resize-none rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] px-3 py-2 text-[var(--lilac-ink)] text-sm outline-none transition focus:border-[var(--lilac-border-strong)]"
						data-testid="chat-instructions-input"
						onChange={event => setDraftInstructions(event.target.value)}
						value={draftInstructions}
					/>
					<div className="mt-3 flex items-center justify-end gap-2">
						<button
							type="button"
							data-testid="chat-instructions-reset"
							className="cursor-pointer rounded-lg px-3 py-2 font-semibold text-[var(--lilac-ink-muted)] text-xs uppercase tracking-[0.12em] transition hover:bg-[var(--lilac-card-muted)]"
							onClick={() => setDraftInstructions(chatInstructions)}
						>
							Reset
						</button>
						<button
							type="button"
							data-testid="chat-instructions-save"
							className="cursor-pointer rounded-lg bg-[var(--lilac-ink)] px-4 py-2 font-semibold text-[var(--lilac-surface)] text-xs uppercase tracking-[0.12em] transition hover:opacity-90"
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
						data-testid="chat-text-input"
						onChange={event => setDraftMessage(event.target.value)}
						placeholder="Type a message"
						className="h-11 w-full rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] px-3 text-[var(--lilac-ink)] text-sm outline-none transition focus:border-[var(--lilac-border-strong)]"
					/>
					<button
						type="submit"
						data-testid="chat-text-send"
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
