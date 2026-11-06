# chigzo Logo Design Brief

## Overview
A minimalist wordmark logo for the "chigzo" application, featuring bold rounded typography with distinctive letterform details.

## Specifications

### 1. Wordmark
- **Text**: `chigzo` (entirely lowercase)
- **Case**: Lowercase only - the lowercase format creates a modern, minimalist, and distinctive visual identity
- **Purpose**: Instant recognition as a clean wordmark

### 2. Typography
- **Typeface Style**: Heavy, rounded, sans-serif
- **Font Weight**: 900 (Extra Black)
- **Font Family**: Inter, system-ui, -apple-system, sans-serif (or similar rounded grotesque)
- **Font Size**: Scalable - look at 72px as reference for 400px width
- **Letter-spacing (Tracking)**: 0.5 units (slightly tightened for cohesion)
- **Rounded terminals**: All stroke endings have rounded caps, not square

### 3. Color Palette
- **Primary**: `#000000` - Solid black lettering
- **Background**: `#FAF3E2` - Warm pale cream/off-white (as specified)
- **Contrast**: High contrast black on warm off-white for timeless appearance
- **Alternative**: Can be reversed (white on dark background) for specific use cases

### 4. Unique Letter Design Elements

#### **Lowercase 'g' - Stylized Geometric Shape**
- Features a geometric lower loop connected to the main stem
- The tail curves under and connects back to the stem at a moderate angle
- Maintains the rounded aesthetic while having distinct structure
- Width proportions: approximately 1.3x the height of other letters

```svg
<path d="M130 50 C 140 45 160 45 170 50 C 180 55 180 65 170 70 C 160 75 140 75 130 70 C 120 75 100 75 110 70 Q 120 65 130 60 Q 105 65 110 70 Q 115 75 130 70 Z"/>
```

#### **Lowercase 'i' - Square Accent Above**
- Minimalist vertical stroke at the baseline
- **Square dot/accent** positioned centrally above the stroke
- Square dimensions: 8px × 8px (relative to 72px font size)
- Square placement: centered at x=100, positioned at y=35 (top of stroke) and y=75 (bottom of stroke)

```svg
<rect x="95" y="35" width="8" height="40" fill="#000000"/>
<path d="M101 35 Q 105 25 110 35 Q 115 25 119 35 M101 75 Q 105 85 110 75 Q 115 85 119 75"/>
```

### 5. Depth Effect
- **Drop Shadow**: Subtle lower-right shadow for dimension
- **Shadow Offset**: dx="4", dy="4" (4 pixels right, 4 pixels down)
- **Shadow Blur**: stdDeviation="3" (soft, diffused edge)
- **Shadow Color**: `#000000` at 20% opacity (`flood-opacity="0.2"`)
- **Purpose**: Adds dimension while maintaining simple/professional look
- **Filter**: `<feDropShadow>` applied to text copy underneath

### 6. Visual Style Guidelines
- **Overall Aesthetic**: Minimalist, modern, playful, youthful
- **Brand Personality**: Bold, energetic, approachable, innovative
- **Scalability**: Designed to work at various sizes (from app icons to large displays)
- **Clear Space**: Minimum clear space around the wordmark equal to the height of the lowercase 'o'
- **Minimum Size**: Not less than 16px height in print/digital interfaces

### 7. Usage Contexts
- **Flutter Mobile App**: Splash screen, AppBar titles, widget labels
- **Admin Web Dashboard**: Page headers, navigation, alerts
- **Organizer Web App**: Landing page, dashboard, settings
- **App Icons**: Derived from wordmark mark (may simplify for small sizes)
- **Loading States**: Animated version available if needed

### 8. SVG Implementation
The provided SVG file (`chigzo_logo.svg`) includes:
- Complete wordmark construction with all letter paths
- Drop shadow filter definition
- Text element for reference/hyperlink purposes
- ViewBox: 0 0 400 100 (scale-independent)
- Colors in Hex format for easy theming

### 9. Construction Notes for Designers
- All letters share consistent height (cap height alignment)
- The 'c' starts the word with a rounded curve
- 'h' has a small vertical element with subtle curve
- 'i' is minimalist with the signature square accent
- 'g' has a distinctive geometric lower loop
- 'z' finishes with a rounded curve matching the 'c'
- Negative space between letters is intentional for readability
- Maintain the rounded aesthetic - avoid straight-line terminals where curves are specified

### 10. Color Codes for Development
| Usage | Hex Code | RGB | Notes |
|-------|----------|-----|-------|
| Black Text | `#000000` | 0, 0, 0 | Primary letter color |
| Warm Off-White Background | `#FAF3E2` | 250, 243, 226 | Primary background |
| Shadow Color | `#000000` with α=0.2 | 0, 0, 0, 0.2 | Drop shadow |

### 11. Future Considerations
- **App Icon**: Could be a simplified version of the wordmark (just the 'g' or 'ch' monogram)
- **Animated Loading**: Subtle pulse or fade-in animation for splash screens
- **Dark Mode**: Inverted version (white on `#1A1A1A` or similar dark background)
- **Brand Assets**: Favicons, loading spinners, error states, success states

---
*Last Updated: November 2026*
*Version 1.0 - Initial specification for chigzo wordmark logo*
