'use client'

import * as SliderPrimitive from '@radix-ui/react-slider'
import * as React from 'react'

import { cn } from '@/lib/utils'

const Slider = React.forwardRef<
	React.ElementRef<typeof SliderPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root>
>(({ className, ...props }, ref) => (
	<SliderPrimitive.Root
		ref={ref}
		data-slot="slider"
		className={cn('relative flex w-full touch-none select-none items-center py-1', className)}
		{...props}
	>
		<SliderPrimitive.Track
			data-slot="slider-track"
			className="relative h-2 w-full grow overflow-hidden rounded-full border border-[var(--lilac-border)] bg-[var(--lilac-card-muted)]"
		>
			<SliderPrimitive.Range
				data-slot="slider-range"
				className="absolute h-full bg-[var(--lilac-ink)]"
			/>
		</SliderPrimitive.Track>
		<SliderPrimitive.Thumb
			data-slot="slider-thumb"
			className="block h-5 w-5 rounded-full border border-[var(--lilac-border-strong)] bg-white shadow-[0_8px_20px_rgba(0,0,0,0.28)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
		/>
	</SliderPrimitive.Root>
))
Slider.displayName = SliderPrimitive.Root.displayName

export { Slider }
