'use client'

import type { ReactNode } from 'react'

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
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useLilacModeRuntime } from '@/realtime/modeRuntimeStore'
import type { LilacMode } from '@/realtime/sessionTypes'

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

type GlobalSettingsContentProps = {
	connectionState: string
	errorMessage: null | string
	setVoiceInputEnabled: (value: boolean) => void
	statusMessage: null | string
	voiceInputEnabled: boolean
}

function GlobalSettingsContent({
	connectionState,
	errorMessage,
	setVoiceInputEnabled,
	statusMessage,
	voiceInputEnabled
}: GlobalSettingsContentProps) {
	return (
		<div className="space-y-4">
			<section className="space-y-2 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-4">
				<div className="flex items-center justify-between gap-3">
					<div>
						<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]">
							Voice Input
						</div>
						<p className="text-[var(--lilac-ink-muted)] text-sm">Use microphone in Chat and Translate.</p>
					</div>
					<Switch
						checked={voiceInputEnabled}
						onCheckedChange={setVoiceInputEnabled}
						data-testid="global-voice-input-toggle"
					/>
				</div>
			</section>

			{statusMessage || errorMessage ? (
				<section className="space-y-2 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-card)] p-4">
					<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]">
						Connection
					</div>
					<div className="text-sm">
						{statusMessage ? <p className="text-[var(--lilac-ink-muted)]">{statusMessage}</p> : null}
						<p className="text-[var(--lilac-ink-muted)]">State: {connectionState}</p>
						{errorMessage ? (
							<p className="mt-1 text-[var(--destructive)]" data-testid="mode-error-banner">
								{errorMessage}
							</p>
						) : null}
					</div>
				</section>
			) : null}
		</div>
	)
}

export default function ModeShell() {
	const {
		connectionState,
		errorMessage,
		mode,
		setMode,
		setVoiceInputEnabled,
		statusMessage,
		voiceInputEnabled
	} = useLilacModeRuntime()

	return (
		<div className="h-[100dvh] overflow-hidden bg-[var(--lilac-surface)]">
			<div className="-z-10 pointer-events-none absolute inset-0 bg-[radial-gradient(140%_100%_at_50%_-24%,color-mix(in_oklab,var(--lilac-direction-secondary)_15%,transparent)_0%,transparent_74%)]" />
			<div className="mx-auto flex h-[100dvh] w-full max-w-5xl flex-col px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
				<header className="sticky top-0 z-20 border-[var(--lilac-border)] border-b bg-[color-mix(in_oklab,var(--lilac-surface)_86%,transparent)] py-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur">
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
										className="rounded-full px-4 font-semibold text-[11px] uppercase tracking-[0.14em] data-[state=active]:bg-[var(--lilac-brand-primary)] data-[state=active]:text-[var(--lilac-brand-primary-foreground)]"
									>
										Chat
									</TabsTrigger>
									<TabsTrigger
										value="translate"
										data-testid="mode-tab-translate"
										className="rounded-full px-4 font-semibold text-[11px] uppercase tracking-[0.14em] data-[state=active]:bg-[var(--lilac-brand-primary)] data-[state=active]:text-[var(--lilac-brand-primary-foreground)]"
									>
										Translate
									</TabsTrigger>
								</TabsList>
							</Tabs>

							<Dialog>
								<DialogTrigger asChild>
									<Button
										type="button"
										variant="outline"
										className="hidden rounded-full border-[var(--lilac-border)] bg-[var(--lilac-elevated)] px-4 text-[11px] uppercase tracking-[0.12em] sm:inline-flex"
										data-testid="global-settings-open-desktop"
									>
										Settings
									</Button>
								</DialogTrigger>
								<DialogContent className="border-[var(--lilac-border)] bg-[var(--lilac-surface)] sm:max-w-lg">
									<DialogHeader>
										<DialogTitle className="text-[var(--lilac-ink)]">Settings</DialogTitle>
										<DialogDescription className="text-[var(--lilac-ink-muted)]">
											Voice controls and connection diagnostics.
										</DialogDescription>
									</DialogHeader>
									<GlobalSettingsContent
										connectionState={connectionState}
										errorMessage={errorMessage}
										setVoiceInputEnabled={setVoiceInputEnabled}
										statusMessage={statusMessage}
										voiceInputEnabled={voiceInputEnabled}
									/>
								</DialogContent>
							</Dialog>

							<Sheet>
								<SheetTrigger asChild>
									<Button
										type="button"
										variant="outline"
										className="rounded-full border-[var(--lilac-border)] bg-[var(--lilac-elevated)] px-4 text-[11px] uppercase tracking-[0.12em] sm:hidden"
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
											Voice controls and connection diagnostics.
										</SheetDescription>
									</SheetHeader>
									<GlobalSettingsContent
										connectionState={connectionState}
										errorMessage={errorMessage}
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
