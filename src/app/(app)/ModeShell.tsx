'use client'

import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import ChatMode from '@/app/(app)/ChatMode'
import TranslateMode from '@/app/(app)/TranslateMode'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger
} from '@/components/ui/dialog'
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useLilacModeRuntime } from '@/realtime/modeRuntimeStore'
import type { LilacMode } from '@/realtime/sessionTypes'

const defaultChatInstructions =
	'You are Lilac. Help users communicate across languages. Keep answers concise, faithful, and practical.'

function normalizeTurnDelaySeconds(value: number): number {
	const clampedValue = Math.min(6, Math.max(0.2, value))
	return Math.round(clampedValue * 10) / 10
}

function renderMode(mode: LilacMode): ReactNode {
	switch (mode) {
		case 'chat':
			return <ChatMode />
		case 'translate':
			return <TranslateMode />
		default:
			return <ChatMode />
	}
}

type UnifiedSettingsContentProps = {
	chatInstructions: string
	chatSpeechOutputEnabled: boolean
	chatTurnDelaySeconds: number
	connectionState: string
	draftInstructions: string
	draftTurnDelaySeconds: number
	errorMessage: null | string
	mode: LilacMode
	onDraftInstructionsChange: (value: string) => void
	onDraftTurnDelayChange: (value: number) => void
	onResetChatSettings: () => void
	onSaveChatSettings: () => void
	saveMessage: string
	setChatSpeechOutputEnabled: (value: boolean) => void
	setVoiceInputEnabled: (value: boolean) => void
	statusMessage: null | string
	voiceInputEnabled: boolean
}

function UnifiedSettingsContent({
	chatInstructions,
	chatSpeechOutputEnabled,
	chatTurnDelaySeconds,
	connectionState,
	draftInstructions,
	draftTurnDelaySeconds,
	errorMessage,
	mode,
	onDraftInstructionsChange,
	onDraftTurnDelayChange,
	onResetChatSettings,
	onSaveChatSettings,
	saveMessage,
	setChatSpeechOutputEnabled,
	setVoiceInputEnabled,
	statusMessage,
	voiceInputEnabled
}: UnifiedSettingsContentProps) {
	const shouldShowDiagnostics =
		!!errorMessage ||
		connectionState === 'error' ||
		(connectionState !== 'connected' && !!statusMessage) ||
		statusMessage === 'Offline. Waiting for network…'

	return (
		<div className="space-y-4">
			<section className="space-y-2 rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-4">
				<div className="flex items-center justify-between gap-3">
					<div>
						<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]">
							Microphone
						</div>
						<p className="text-[var(--lilac-ink-muted)] text-sm">
							Use voice input in Chat and Translate.
						</p>
					</div>
					<Switch
						checked={voiceInputEnabled}
						onCheckedChange={setVoiceInputEnabled}
						data-testid="global-voice-input-toggle"
					/>
				</div>
			</section>

			{mode === 'chat' ? (
				<section className="space-y-3 rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-4">
					<div className="flex items-center justify-between gap-3">
						<div>
							<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]">
								Speech Output
							</div>
							<p className="text-[var(--lilac-ink-muted)] text-sm">Play spoken responses in chat.</p>
						</div>
						<Switch
							checked={chatSpeechOutputEnabled}
							onCheckedChange={setChatSpeechOutputEnabled}
							data-testid="chat-speech-output-toggle"
						/>
					</div>

					<div className="space-y-2">
						<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]">
							End Of Speech Delay
						</div>
						<Slider
							value={[draftTurnDelaySeconds]}
							min={0.2}
							max={6}
							step={0.1}
							onValueChange={valueList => {
								const nextValue = valueList[0]
								if (typeof nextValue !== 'number') return
								onDraftTurnDelayChange(normalizeTurnDelaySeconds(nextValue))
							}}
							onValueCommit={valueList => {
								const nextValue = valueList[0]
								if (typeof nextValue !== 'number') return
								onDraftTurnDelayChange(normalizeTurnDelaySeconds(nextValue))
							}}
							data-testid="chat-turn-delay-slider"
						/>
						<div className="flex items-center justify-between text-sm">
							<span className="text-[var(--lilac-ink-muted)]">Delay</span>
							<span className="font-semibold text-[var(--lilac-ink)]">
								{draftTurnDelaySeconds.toFixed(1)}s
							</span>
						</div>
					</div>

					<div className="space-y-2">
						<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]">
							Instructions
						</div>
						<Textarea
							className="min-h-28 border-[var(--lilac-border)] bg-[var(--lilac-card-muted)] text-[var(--lilac-ink)]"
							data-testid="chat-instructions-input"
							onChange={event => onDraftInstructionsChange(event.target.value)}
							value={draftInstructions}
						/>
						<div className="flex items-center justify-between gap-2">
							<Button
								type="button"
								variant="outline"
								data-testid="chat-instructions-reset"
								onClick={onResetChatSettings}
							>
								Reset
							</Button>
							<Button type="button" data-testid="chat-instructions-save" onClick={onSaveChatSettings}>
								Save
							</Button>
						</div>
						{saveMessage ? (
							<output className="block text-[var(--lilac-ink-muted)] text-xs" aria-live="polite">
								{saveMessage}
							</output>
						) : null}
						{draftInstructions.trim() === '' && chatInstructions.trim() === '' ? (
							<p className="text-[var(--lilac-ink-muted)] text-xs">
								Empty instructions revert to default behavior.
							</p>
						) : null}
						{chatTurnDelaySeconds !== draftTurnDelaySeconds ? (
							<p className="text-[var(--lilac-ink-muted)] text-xs">Save to apply new delay in chat.</p>
						) : null}
					</div>
				</section>
			) : null}

			{shouldShowDiagnostics ? (
				<section className="space-y-2 rounded-xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-4">
					<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]">
						Connection
					</div>
					{statusMessage ? (
						<p className="text-[var(--lilac-ink-muted)] text-sm">{statusMessage}</p>
					) : null}
					<p className="text-[var(--lilac-ink-muted)] text-sm">State: {connectionState}</p>
					{errorMessage ? (
						<p className="text-[var(--destructive)] text-sm" data-testid="mode-error-banner">
							{errorMessage}
						</p>
					) : null}
				</section>
			) : null}
		</div>
	)
}

export default function ModeShell() {
	const {
		chatInstructions,
		chatSpeechOutputEnabled,
		chatTurnDelaySeconds,
		connectionState,
		errorMessage,
		mode,
		setChatInstructions,
		setChatSpeechOutputEnabled,
		setChatTurnDelaySeconds,
		setMode,
		setVoiceInputEnabled,
		statusMessage,
		voiceInputEnabled
	} = useLilacModeRuntime()

	const [draftInstructions, setDraftInstructions] = useState(chatInstructions)
	const [draftTurnDelaySeconds, setDraftTurnDelaySeconds] = useState(chatTurnDelaySeconds)
	const [saveMessage, setSaveMessage] = useState('')

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

	function saveChatSettings(): void {
		setChatInstructions(draftInstructions.trim() || defaultChatInstructions)
		setChatTurnDelaySeconds(normalizeTurnDelaySeconds(draftTurnDelaySeconds))
		setSaveMessage('Saved')
	}

	function resetChatSettings(): void {
		setDraftInstructions(chatInstructions || defaultChatInstructions)
		setDraftTurnDelaySeconds(chatTurnDelaySeconds)
	}

	return (
		<div className="h-[100dvh] overflow-hidden bg-[var(--lilac-surface)]">
			<div className="-z-10 pointer-events-none absolute inset-0 bg-[radial-gradient(140%_100%_at_50%_-24%,color-mix(in_oklab,var(--lilac-direction-secondary)_14%,transparent)_0%,transparent_74%)]" />
			<div className="mx-auto flex h-[100dvh] w-full max-w-5xl flex-col px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
				<header className="sticky top-0 z-20 border-[var(--lilac-border)] border-b bg-[color-mix(in_oklab,var(--lilac-surface)_88%,transparent)] py-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
					<div className="flex items-center justify-between gap-3">
						<div className="font-semibold text-[13px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.2em]">
							Lilac
						</div>

						<div className="flex items-center gap-2">
							<Tabs
								value={mode}
								onValueChange={value => {
									if (value === 'chat' || value === 'translate') setMode(value)
								}}
							>
								<TabsList className="h-10 rounded-full border border-[var(--lilac-border)] bg-[var(--lilac-elevated)] p-1">
									<TabsTrigger
										value="chat"
										data-testid="mode-tab-chat"
										className="rounded-full px-4 text-xs"
									>
										Chat
									</TabsTrigger>
									<TabsTrigger
										value="translate"
										data-testid="mode-tab-translate"
										className="rounded-full px-4 text-xs"
									>
										Translate
									</TabsTrigger>
								</TabsList>
							</Tabs>

							<Button
								type="button"
								variant="outline"
								data-testid="header-voice-input-toggle"
								onClick={() => setVoiceInputEnabled(!voiceInputEnabled)}
								className="h-9 w-9 rounded-full p-0"
								aria-label={voiceInputEnabled ? 'Disable microphone' : 'Enable microphone'}
								title={voiceInputEnabled ? 'Mic on' : 'Mic off'}
							>
								{voiceInputEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
							</Button>

							{mode === 'chat' ? (
								<Button
									type="button"
									variant="outline"
									data-testid="header-chat-speech-toggle"
									onClick={() => setChatSpeechOutputEnabled(!chatSpeechOutputEnabled)}
									className="h-9 w-9 rounded-full p-0"
									aria-label={chatSpeechOutputEnabled ? 'Disable speech output' : 'Enable speech output'}
									title={chatSpeechOutputEnabled ? 'Speech on' : 'Speech off'}
								>
									{chatSpeechOutputEnabled ? (
										<Volume2 className="h-4 w-4" />
									) : (
										<VolumeX className="h-4 w-4" />
									)}
								</Button>
							) : null}

							<Dialog>
								<DialogTrigger asChild>
									<Button
										type="button"
										variant="outline"
										className="hidden h-9 rounded-full px-3 text-[11px] uppercase tracking-[0.12em] sm:inline-flex"
										data-testid="global-settings-open-desktop"
									>
										Settings
									</Button>
								</DialogTrigger>
								<DialogContent className="max-h-[88dvh] overflow-hidden border-[var(--lilac-border)] bg-[var(--lilac-surface)] p-0 sm:max-w-lg">
									<DialogHeader className="border-[var(--lilac-border)] border-b px-5 pt-5 pb-4">
										<DialogTitle className="text-[var(--lilac-ink)]">Settings</DialogTitle>
										<DialogDescription className="text-[var(--lilac-ink-muted)]">
											Audio, chat behavior, and diagnostics.
										</DialogDescription>
									</DialogHeader>
									<div className="overflow-y-auto px-5 py-4">
										<UnifiedSettingsContent
											chatInstructions={chatInstructions}
											chatSpeechOutputEnabled={chatSpeechOutputEnabled}
											chatTurnDelaySeconds={chatTurnDelaySeconds}
											connectionState={connectionState}
											draftInstructions={draftInstructions}
											draftTurnDelaySeconds={draftTurnDelaySeconds}
											errorMessage={errorMessage}
											mode={mode}
											onDraftInstructionsChange={setDraftInstructions}
											onDraftTurnDelayChange={setDraftTurnDelaySeconds}
											onResetChatSettings={resetChatSettings}
											onSaveChatSettings={saveChatSettings}
											saveMessage={saveMessage}
											setChatSpeechOutputEnabled={setChatSpeechOutputEnabled}
											setVoiceInputEnabled={setVoiceInputEnabled}
											statusMessage={statusMessage}
											voiceInputEnabled={voiceInputEnabled}
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
										data-testid="global-settings-open-mobile"
									>
										Settings
									</Button>
								</SheetTrigger>
								<SheetContent
									side="bottom"
									className="max-h-[90dvh] overflow-y-auto rounded-t-2xl border-[var(--lilac-border)] bg-[var(--lilac-surface)] px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
								>
									<SheetHeader className="pb-2 text-left">
										<SheetTitle className="text-[var(--lilac-ink)]">Settings</SheetTitle>
										<SheetDescription className="text-[var(--lilac-ink-muted)]">
											Audio, chat behavior, and diagnostics.
										</SheetDescription>
									</SheetHeader>
									<UnifiedSettingsContent
										chatInstructions={chatInstructions}
										chatSpeechOutputEnabled={chatSpeechOutputEnabled}
										chatTurnDelaySeconds={chatTurnDelaySeconds}
										connectionState={connectionState}
										draftInstructions={draftInstructions}
										draftTurnDelaySeconds={draftTurnDelaySeconds}
										errorMessage={errorMessage}
										mode={mode}
										onDraftInstructionsChange={setDraftInstructions}
										onDraftTurnDelayChange={setDraftTurnDelaySeconds}
										onResetChatSettings={resetChatSettings}
										onSaveChatSettings={saveChatSettings}
										saveMessage={saveMessage}
										setChatSpeechOutputEnabled={setChatSpeechOutputEnabled}
										setVoiceInputEnabled={setVoiceInputEnabled}
										statusMessage={statusMessage}
										voiceInputEnabled={voiceInputEnabled}
									/>
								</SheetContent>
							</Sheet>
						</div>
					</div>

					{statusMessage ? (
						<p className="pt-2 text-[var(--lilac-ink-muted)] text-xs" data-testid="mode-status-message">
							{statusMessage}
						</p>
					) : null}
				</header>

				<main className="flex min-h-0 flex-1 flex-col overflow-hidden py-3">{renderMode(mode)}</main>
			</div>
		</div>
	)
}
