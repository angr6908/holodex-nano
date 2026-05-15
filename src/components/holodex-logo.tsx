import type { SVGProps } from "react"

import { cn } from "@/lib/utils"

export function HolodexLogo({
  width = 49.531,
  height = 46.719,
  className,
  ...props
}: SVGProps<SVGSVGElement> & {
  width?: number | string
  height?: number | string
}) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 49.531 46.719"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("block", className)}
      {...props}
    >
      <g transform="translate(-71.24 -130.01)">
        <path
          d="m118.65 149.7a4.2333 4.2333 0 0 1 0 7.3324l-33.127 19.126a4.2333 4.2333 0 0 1-6.35-3.6662v-38.252a4.2333 4.2333 0 0 1 6.35-3.6662"
          fill="#f06292"
        />
        <path
          d="m110.72 149.68a4.2333 4.2333 0 0 1 0 7.3324l-33.127 19.126a4.2333 4.2333 0 0 1-6.35-3.6662v-38.252a4.2333 4.2333 0 0 1 6.35-3.6662"
          fill="#64b5f6"
        />
      </g>
    </svg>
  )
}
