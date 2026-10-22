// 스플래시용 아이콘을 만든다: 어두운 배경(#0f1218) 위에 올릴, 모서리 둥근 흰 카드 + 로고.
// (원본 brand/icon-1024.png 는 흰 배경이라 그대로 쓰면 다크 배경에 흰 네모가 보인다)
//   swift tool/make-splash-icon.swift <원본> <결과> [캔버스] [여백] [둥글기비율]
// 안드로이드 12+ 는 아이콘을 동그랗게 잘라서, 그쪽은 네모 카드(둥글기 0)로 더 작게 만든다.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write("쓰기: swift make-splash-icon.swift <원본.png> <결과.png> [캔버스] [여백] [둥글기비율]\n".data(using: .utf8)!)
  exit(1)
}
let src = URL(fileURLWithPath: args[1])
let dst = URL(fileURLWithPath: args[2])

guard let source = CGImageSourceCreateWithURL(src as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
  FileHandle.standardError.write("원본을 읽지 못했습니다: \(src.path)\n".data(using: .utf8)!)
  exit(1)
}

let size = args.count > 3 ? Double(args[3])! : 1024.0
let inset = args.count > 4 ? Double(args[4])! : 96.0 // 카드 바깥 여백
let radiusRatio = args.count > 5 ? Double(args[5])! : 0.2237 // 아이폰 아이콘과 비슷한 둥글기
let card = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let radius = card.width * radiusRatio

guard let context = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8,
                              bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
  exit(1)
}
context.interpolationQuality = .high
context.clear(CGRect(x: 0, y: 0, width: size, height: size))
let path = CGPath(roundedRect: card, cornerWidth: radius, cornerHeight: radius, transform: nil)
context.addPath(path)
context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
context.fillPath()
context.addPath(path)
context.clip()
context.draw(image, in: card)

guard let out = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(dst as CFURL, UTType.png.identifier as CFString, 1, nil) else {
  exit(1)
}
CGImageDestinationAddImage(destination, out, nil)
guard CGImageDestinationFinalize(destination) else { exit(1) }
print("만들었습니다: \(dst.path)")
