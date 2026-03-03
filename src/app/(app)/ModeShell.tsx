'use client'

import type { ReactNode } from 'react'

import ChatMode from '@/app/(app)/ChatMode'
import TranslateMode from '@/app/(app)/TranslateMode'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

function getConnectionStateLabel(connectionState: string): string {
	switch (connectionState) {
		case 'connecting':
			return 'Connecting'
		case 'connected':
			return 'Live'
		case 'error':
			return 'Error'
		default:
			return 'Idle'
	}
}

export default function ModeShell() {
	const {
		clearCurrentModeHistory,
		connectionState,
		errorMessage,
		mode,
		reconnectCurrentMode,
		setMode,
		setVoiceInputEnabled,
		voiceInputEnabled
	} = useLilacModeRuntime()

	return (
		<div className="relative min-h-[100dvh] overflow-hidden bg-[var(--lilac-surface)]">
			<div className="-z-10 pointer-events-none absolute inset-0 bg-[radial-gradient(130%_100%_at_50%_-18%,rgba(255,255,255,0.8)_0%,rgba(255,255,255,0.05)_72%,rgba(255,255,255,0)_100%)]" />
			<div className="mx-auto flex min-h-[100dvh] w-full max-w-5xl flex-col px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
				<header className="sticky top-0 z-20 flex flex-col gap-3 border-[var(--lilac-border)] border-b bg-[color-mix(in_oklab,var(--lilac-surface)_88%,transparent)] pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
					<div className="flex items-center justify-between gap-3">
						<div className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.18em]">
							Lilac
						</div>
						<div className="flex items-center gap-2">
							<Badge
								className="rounded-full border border-[var(--lilac-border)] bg-[var(--lilac-elevated)] px-3 py-1 text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]"
								data-testid="mode-active-badge"
							>
								{mode}
							</Badge>
							<Badge
								className="rounded-full border border-[var(--lilac-border)] bg-[var(--lilac-elevated)] px-3 py-1 text-[10px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.14em]"
								data-testid="connection-state-badge"
							>
								{getConnectionStateLabel(connectionState)}
							</Badge>
						</div>
					</div>

					<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
						<Tabs
							value={mode}
							onValueChange={value => {
								if (value === 'chat' || value === 'translate') setMode(value)
							}}
						>
							<TabsList className="grid h-11 w-full grid-cols-2 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-elevated)] p-1">
								<TabsTrigger
									value="chat"
									data-testid="mode-tab-chat"
									className="rounded-xl font-semibold text-[11px] uppercase tracking-[0.12em] data-[state=active]:bg-[var(--lilac-ink)] data-[state=active]:text-[var(--lilac-surface)]"
								>
									Chat
								</TabsTrigger>
								<TabsTrigger
									value="translate"
									data-testid="mode-tab-translate"
									className="rounded-xl font-semibold text-[11px] uppercase tracking-[0.12em] data-[state=active]:bg-[var(--lilac-ink)] data-[state=active]:text-[var(--lilac-surface)]"
								>
									Live
								</TabsTrigger>
							</TabsList>
						</Tabs>

						<div className="flex items-center justify-between gap-2 rounded-2xl border border-[var(--lilac-border)] bg-[var(--lilac-elevated)] px-3 py-2">
							<span className="font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]">
								Voice Input
							</span>
							<Switch
								checked={voiceInputEnabled}
								onCheckedChange={checked => setVoiceInputEnabled(checked)}
								data-testid="global-voice-input-toggle"
								className="data-[state=checked]:bg-[var(--lilac-direction-primary)] data-[state=unchecked]:bg-[var(--lilac-border)]"
							/>
						</div>
					</div>

					<div className="flex items-center justify-end gap-2">
						<Button
							type="button"
							data-testid="clear-mode-history"
							variant="outline"
							className="h-9 rounded-xl border-[var(--lilac-border)] bg-[var(--lilac-elevated)] font-semibold text-[11px] text-[var(--lilac-ink-muted)] uppercase tracking-[0.12em]"
							onClick={clearCurrentModeHistory}
						>
							Clear
						</Button>
						<Button
							type="button"
							data-testid="reconnect-mode"
							className="h-9 rounded-xl bg-[var(--lilac-ink)] px-4 font-semibold text-[11px] text-[var(--lilac-surface)] uppercase tracking-[0.12em]"
							onClick={reconnectCurrentMode}
						>
							Reconnect
						</Button>
					</div>
				</header>

				<main className="flex min-h-0 flex-1 flex-col gap-3 py-3">
					{errorMessage ? (
						<div
							className="rounded-2xl border border-red-500/45 bg-red-100/80 px-4 py-3 text-red-900 text-sm"
							data-testid="mode-error-banner"
						>
							{errorMessage}
						</div>
					) : null}

					<div className="flex min-h-0 flex-1 flex-col">{renderMode(mode)}</div>
				</main>
			</div>
		</div>
	)
}
