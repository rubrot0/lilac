'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger
} from '@/components/ui/sheet'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useLilacModeRuntime } from '@/realtime/modeRuntimeStore'

const defaultChatInstructions =
	'You are Lilac. Help users communicate across languages. Keep answers concise, faithful, and practical.'

type ChatSettingsContentProps = {
	chatInstructions: string
	chatSpeechOutputEnabled: boolean
	draftInstructions: string
	draftTurnDelaySeconds: number
	saveMessage: string
	setChatInstructions: (instructions: string) => void
	setChatSpeechOutputEnabled: (enabled: boolean) => void
	setChatTurnDelaySeconds: (seconds: number) => void
	setDraftInstructions: (instructions: string) => void
	setDraftTurnDelaySeconds: (seconds: number) => void
	setSaveMessage: (value: string) => void
	voiceInputEnabled: boolean
}

function normalizeTurnDelaySeconds(value: number): number {
	const clampedValue = Math.min(6, Math.max(0.2, value))
	return Math.round(clampedValue * 10) / 10
}

function ChatSettingsContent({
	chatInstructions,
	chatSpeechOutputEnabled,
	draftInstructions,
	draftTurnDelaySeconds,
	saveMessage,
	setChatInstructions,
	setChatSpeechOutputEnabled,
	setChatTurnDelaySeconds,
	setDraftInstructions,
	setDraftTurnDelaySeconds,
	setSaveMessage,
	voiceInputEnabled
}: ChatSettingsContentProps) {
	return (
		<div className="space-y-4" data-testid="chat-settings-surface">
			<div className="space-y-2 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-3">
				<div className="flex items-center justify-between gap-3">
					<div className="space-y-1">
						<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
							Speech output
						</div>
						<p className="text-[var(--lilac-ink-muted)] text-sm">
							Voice input is {voiceInputEnabled ? 'enabled' : 'disabled'} globally.
						</p>
					</div>
					<Switch
						checked={chatSpeechOutputEnabled}
						onCheckedChange={checked => setChatSpeechOutputEnabled(checked)}
						data-testid="chat-speech-output-toggle"
						className="data-[state=checked]:bg-[var(--lilac-direction-primary)] data-[state=unchecked]:bg-[var(--lilac-border)]"
					/>
				</div>

				<div className="space-y-2 pt-2">
					<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
						End-of-speech delay
					</div>
					<Slider
						value={[draftTurnDelaySeconds]}
						min={0.2}
						max={6}
						step={0.1}
						onValueChange={valueList => {
							const nextValue = valueList[0]
							if (typeof nextValue !== 'number') return
							setDraftTurnDelaySeconds(normalizeTurnDelaySeconds(nextValue))
						}}
						onValueCommit={valueList => {
							const nextValue = valueList[0]
							if (typeof nextValue !== 'number') return
							const normalizedValue = normalizeTurnDelaySeconds(nextValue)
							setDraftTurnDelaySeconds(normalizedValue)
							setChatTurnDelaySeconds(normalizedValue)
						}}
						data-testid="chat-turn-delay-slider"
						className="[&_[data-slot=slider-range]]:bg-[var(--lilac-brand-primary)]"
					/>
					<div className="flex items-center justify-between text-sm">
						<span className="text-[var(--lilac-ink-muted)]">Delay</span>
						<span className="font-semibold text-[var(--lilac-ink)]">
							{draftTurnDelaySeconds.toFixed(1)}s
						</span>
					</div>
				</div>
			</div>

			<div className="space-y-2 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-3">
				<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
					Instructions
				</div>
				<Textarea
					className="min-h-32 border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] text-[var(--lilac-ink)]"
					data-testid="chat-instructions-input"
					onChange={event => setDraftInstructions(event.target.value)}
					value={draftInstructions}
				/>
				<div className="flex items-center justify-end gap-2">
					<Button
						type="button"
						variant="outline"
						data-testid="chat-instructions-reset"
						className="border-[var(--lilac-border)] bg-[var(--lilac-elevated)] text-[var(--lilac-ink)]"
						onClick={() => {
							setDraftInstructions(chatInstructions)
							setDraftTurnDelaySeconds(normalizeTurnDelaySeconds(draftTurnDelaySeconds))
						}}
					>
						Reset
					</Button>
					<Button
						type="button"
						data-testid="chat-instructions-save"
						className="bg-[var(--lilac-brand-primary)] text-[var(--lilac-brand-primary-foreground)]"
						onClick={() => {
							setChatInstructions(draftInstructions.trim() || defaultChatInstructions)
							setSaveMessage('Saved')
						}}
					>
						Save
					</Button>
				</div>
				{saveMessage ? (
					<output className="block text-[var(--lilac-ink-muted)] text-xs" aria-live="polite">
						{saveMessage}
					</output>
				) : null}
			</div>
		</div>
	)
}

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
	const [draftTurnDelaySeconds, setDraftTurnDelaySeconds] = useState(chatTurnDelaySeconds)
	const [desktopSettingsOpen, setDesktopSettingsOpen] = useState(false)
	const [mobileSettingsOpen, setMobileSettingsOpen] = useState(false)
	const stayPinnedToBottomRef = useRef(true)
	const transcriptScrollAreaRef = useRef<HTMLDivElement | null>(null)
	const transcriptViewportRef = useRef<HTMLDivElement | null>(null)
	const playbackAudioElementRef = useRef<HTMLAudioElement | null>(null)
	const chatTranscriptCount = chatTranscripts.length

	useEffect(() => {
		setDraftInstructions(chatInstructions)
	}, [chatInstructions])

	useEffect(() => {
		setDraftTurnDelaySeconds(chatTurnDelaySeconds)
	}, [chatTurnDelaySeconds])

	useEffect(() => {
		if (!saveMessage) return
		const timeoutId = window.setTimeout(() => setSaveMessage(''), 1500)
		return () => window.clearTimeout(timeoutId)
	}, [saveMessage])

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
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex items-center justify-between rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-elevated)] px-3 py-2">
				<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
					Conversation
				</div>

				<div className="flex items-center gap-2">
					<Dialog open={desktopSettingsOpen} onOpenChange={setDesktopSettingsOpen}>
						<DialogTrigger asChild>
							<Button
								type="button"
								variant="outline"
								className="hidden h-9 rounded-xl border-[var(--lilac-border)] bg-[var(--lilac-card)] text-[var(--lilac-ink)] sm:inline-flex"
								data-testid="chat-settings-open-desktop"
							>
								Settings
							</Button>
						</DialogTrigger>
						<DialogContent className="max-h-[85dvh] overflow-hidden border-[var(--lilac-border)] bg-[var(--lilac-surface)] p-0 sm:max-w-xl">
							<DialogHeader className="border-[var(--lilac-border)] border-b px-4 pt-4 pb-3">
								<DialogTitle className="text-[var(--lilac-ink)]">Chat Settings</DialogTitle>
								<DialogDescription className="text-[var(--lilac-ink-muted)]">
									Control speech output and instructions.
								</DialogDescription>
							</DialogHeader>
							<div className="overflow-y-auto px-4 py-4">
								<ChatSettingsContent
									chatInstructions={chatInstructions}
									chatSpeechOutputEnabled={chatSpeechOutputEnabled}
									draftInstructions={draftInstructions}
									draftTurnDelaySeconds={draftTurnDelaySeconds}
									saveMessage={saveMessage}
									setChatInstructions={setChatInstructions}
									setChatSpeechOutputEnabled={setChatSpeechOutputEnabled}
									setChatTurnDelaySeconds={setChatTurnDelaySeconds}
									setDraftInstructions={setDraftInstructions}
									setDraftTurnDelaySeconds={setDraftTurnDelaySeconds}
									setSaveMessage={setSaveMessage}
									voiceInputEnabled={voiceInputEnabled}
								/>
							</div>
						</DialogContent>
					</Dialog>

					<Sheet open={mobileSettingsOpen} onOpenChange={setMobileSettingsOpen}>
						<SheetTrigger asChild>
							<Button
								type="button"
								variant="outline"
								className="h-9 rounded-xl border-[var(--lilac-border)] bg-[var(--lilac-card)] text-[var(--lilac-ink)] sm:hidden"
								data-testid="chat-settings-open-mobile"
							>
								Settings
							</Button>
						</SheetTrigger>
						<SheetContent
							side="bottom"
							className="max-h-[90dvh] overflow-y-auto rounded-t-2xl border-[var(--lilac-border)] bg-[var(--lilac-surface)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
						>
							<SheetHeader className="pb-2 text-left">
								<SheetTitle className="text-[var(--lilac-ink)]">Chat Settings</SheetTitle>
								<SheetDescription className="text-[var(--lilac-ink-muted)]">
									Control speech output and instructions.
								</SheetDescription>
							</SheetHeader>
							<ChatSettingsContent
								chatInstructions={chatInstructions}
								chatSpeechOutputEnabled={chatSpeechOutputEnabled}
								draftInstructions={draftInstructions}
								draftTurnDelaySeconds={draftTurnDelaySeconds}
								saveMessage={saveMessage}
								setChatInstructions={setChatInstructions}
								setChatSpeechOutputEnabled={setChatSpeechOutputEnabled}
								setChatTurnDelaySeconds={setChatTurnDelaySeconds}
								setDraftInstructions={setDraftInstructions}
								setDraftTurnDelaySeconds={setDraftTurnDelaySeconds}
								setSaveMessage={setSaveMessage}
								voiceInputEnabled={voiceInputEnabled}
							/>
						</SheetContent>
					</Sheet>
				</div>
			</div>

			<ScrollArea
				ref={transcriptScrollAreaRef}
				data-testid="chat-transcript-list"
				className="min-h-0 flex-1 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)]"
			>
				{chatTranscripts.length ? (
					<div className="flex flex-col gap-3 p-3 sm:p-4">
						{chatTranscripts.map(message => {
							const isUser = message.role === 'user'
							const bubbleBaseClasses =
								'max-w-[92%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed'
							const bubbleClasses = isUser
								? `${bubbleBaseClasses} self-end bg-[var(--lilac-brand-primary)] text-[var(--lilac-brand-primary-foreground)]`
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
				className="rounded-2xl border border-[var(--lilac-border)] bg-[color-mix(in_oklab,var(--lilac-card)_84%,transparent)] p-2"
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
