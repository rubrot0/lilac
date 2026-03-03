'use client'

import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { useLilacModeRuntime } from '@/realtime/modeRuntimeStore'

export default function ChatMode() {
	const { chatSpeechOutputEnabled, chatTranscripts, remoteAudioStream, submitChatTextInput } =
		useLilacModeRuntime()

	const [draftMessage, setDraftMessage] = useState('')
	const stayPinnedToBottomRef = useRef(true)
	const transcriptScrollAreaRef = useRef<HTMLDivElement | null>(null)
	const transcriptViewportRef = useRef<HTMLDivElement | null>(null)
	const playbackAudioElementRef = useRef<HTMLAudioElement | null>(null)
	const chatTranscriptCount = chatTranscripts.length

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
		if (chatTranscriptCount === 0) return
		if (!stayPinnedToBottomRef.current) return
		const viewportElement = transcriptViewportRef.current
		if (!viewportElement) return
		viewportElement.scrollTo({ behavior: 'auto', top: viewportElement.scrollHeight })
	}, [chatTranscriptCount])

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
		<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
			<div className="rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] px-3 py-2">
				<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
					Conversation
				</div>
			</div>

			<ScrollArea
				ref={transcriptScrollAreaRef}
				data-testid="chat-transcript-list"
				className="min-h-0 flex-1 rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card)]"
			>
				{chatTranscripts.length ? (
					<div className="flex flex-col gap-3 p-3 sm:p-4">
						{chatTranscripts.map(message => {
							const isUser = message.role === 'user'
							const bubbleBaseClass =
								'max-w-[92%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed'
							const bubbleClass = isUser
								? `${bubbleBaseClass} self-end bg-[var(--lilac-brand-primary)] text-[var(--lilac-brand-primary-foreground)]`
								: `${bubbleBaseClass} self-start border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] text-[var(--lilac-ink)]`

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
									<div className={bubbleClass} data-testid={`chat-message-text-${message.id}`}>
										{message.text.trim() || '…'}
									</div>
								</div>
							)
						})}
					</div>
				) : (
					<div
						className="flex min-h-56 items-center justify-center px-4 py-6 text-[var(--lilac-ink-muted)] text-sm"
						data-testid="chat-empty-state"
					>
						Start with voice or type below.
					</div>
				)}
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
						data-testid="chat-text-input"
						onChange={event => setDraftMessage(event.target.value)}
						onKeyDown={event => {
							if (event.key !== 'Enter') return
							if (event.shiftKey) return
							event.preventDefault()
							submitMessage()
						}}
						placeholder="Type a message"
						aria-label="Chat message"
						className="max-h-36 min-h-11 resize-none border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] text-[var(--lilac-ink)]"
					/>
					<Button
						type="submit"
						data-testid="chat-text-send"
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
