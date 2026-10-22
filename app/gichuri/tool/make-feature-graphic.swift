// 플레이 스토어 '그래픽 이미지'(1024x500)를 만든다.
//   swift tool/make-feature-graphic.swift ../../brand/icon-1024.png <결과.png>
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3 else { exit(1) }
let src = URL(fileURLWithPath: args[1])
let dst = URL(fileURLWithPath: args[2])

guard let source = CGImageSourceCreateWithURL(src as CFURL, nil),
      let logo = CGImageSourceCreateImageAtIndex(source, 0, nil) else { exit(1) }

let W = 1024.0, H = 500.0
guard let ctx = CGContext(data: nil, width: Int(W), height: Int(H), bitsPerComponent: 8,
                          bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { exit(1) }
ctx.interpolationQuality = .high

// 배경 (브랜드 다크)
ctx.setFillColor(CGColor(red: 0x0f / 255.0, green: 0x12 / 255.0, blue: 0x18 / 255.0, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

// 포인트 색 띠
ctx.setFillColor(CGColor(red: 0xcf / 255.0, green: 0x3f / 255.0, blue: 0x63 / 255.0, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: W, height: 8))

// 왼쪽: 흰 라운드 카드 안에 로고
let card = CGRect(x: 72, y: (H - 300) / 2, width: 300, height: 300)
let path = CGPath(roundedRect: card, cornerWidth: 300 * 0.2237, cornerHeight: 300 * 0.2237, transform: nil)
ctx.addPath(path)
ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.fillPath()
ctx.saveGState()
ctx.addPath(path); ctx.clip()
ctx.draw(logo, in: card)
ctx.restoreGState()

// 오른쪽: 글
func draw(_ text: String, font: String, size: CGFloat, color: CGColor, x: CGFloat, y: CGFloat) {
  let f = CTFontCreateWithName(font as CFString, size, nil)
  let attrs: [NSAttributedString.Key: Any] = [
    NSAttributedString.Key(kCTFontAttributeName as String): f,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
  ]
  let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
  ctx.textPosition = CGPoint(x: x, y: y)
  CTLineDraw(line, ctx)
}

let white = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
let muted = CGColor(red: 0x98 / 255.0, green: 0xa1 / 255.0, blue: 0xb0 / 255.0, alpha: 1)
let pink = CGColor(red: 0xf1 / 255.0, green: 0x7c / 255.0, blue: 0x99 / 255.0, alpha: 1)

draw("기추리", font: "AppleSDGothicNeo-Bold", size: 76, color: white, x: 430, y: 316)
draw("내 자료로 뽑는 예상 기출", font: "AppleSDGothicNeo-SemiBold", size: 40, color: pink, x: 430, y: 248)
draw("강의노트 PDF만 올리면 1~2분 만에 시험지", font: "AppleSDGothicNeo-Medium", size: 30, color: muted, x: 430, y: 188)
draw("채점 · 해설 · 오답노트까지 한 번에", font: "AppleSDGothicNeo-Medium", size: 30, color: muted, x: 430, y: 142)

guard let out = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(dst as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(dest, out, nil)
guard CGImageDestinationFinalize(dest) else { exit(1) }
print("만들었습니다: \(dst.path)")
