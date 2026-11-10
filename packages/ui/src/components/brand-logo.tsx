import { cn } from "../lib/utils"

/** Aspect ratio of the cropped chigzo wordmark (1063 x 401). */
const LOGO_RATIO = 1063 / 401

interface BrandLogoProps {
  /**
   * `dark` draws the black wordmark for light surfaces.
   * `light` draws the white wordmark for pink/dark surfaces.
   */
  variant?: "dark" | "light"
  /** Rendered height in px. Width follows the wordmark ratio. */
  height?: number
  className?: string
  testId?: string
}

/**
 * The chigzo wordmark. Both web apps serve `logo.svg` / `logo-white.svg`
 * from their `public/` folder, so no asset imports are needed.
 */
export function BrandLogo({
  variant = "dark",
  height = 28,
  className,
  testId = "brand-logo",
}: BrandLogoProps) {
  return (
    <img
      src={variant === "light" ? "/logo-white.svg" : "/logo.svg"}
      alt="chigzo"
      width={Math.round(height * LOGO_RATIO)}
      height={height}
      draggable={false}
      data-testid={testId}
      className={cn("block select-none", className)}
      style={{ height, width: "auto" }}
    />
  )
}
