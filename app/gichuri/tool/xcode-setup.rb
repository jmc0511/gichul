# Xcode 프로젝트에 파일·설정을 넣는다 (여러 번 돌려도 같은 결과).
#   ruby tool/xcode-setup.rb
# - Runner/PrivacyInfo.xcprivacy 를 앱에 포함
# - Runner/GoogleService-Info.plist 가 있으면 앱에 포함 (알림용, 저장소에는 올리지 않음)
# - 알림 권한(entitlements) 연결
require "xcodeproj"

root = File.expand_path("..", __dir__)
project = Xcodeproj::Project.open(File.join(root, "ios/Runner.xcodeproj"))
target = project.targets.find { |t| t.name == "Runner" } or abort "Runner 타깃을 찾지 못했습니다"
group = project.main_group["Runner"] or abort "Runner 그룹을 찾지 못했습니다"

%w[PrivacyInfo.xcprivacy GoogleService-Info.plist].each do |name|
  unless File.exist?(File.join(root, "ios/Runner", name))
    puts "건너뜀: #{name} 파일이 없음"
    next
  end
  ref = group.files.find { |f| f.display_name == name } || group.new_reference(name)
  unless target.resources_build_phase.files_references.include?(ref)
    target.resources_build_phase.add_file_reference(ref, true)
  end
  puts "넣음: #{name}"
end

target.build_configurations.each do |config|
  config.build_settings["CODE_SIGN_ENTITLEMENTS"] = "Runner/Runner.entitlements"
end
puts "설정: CODE_SIGN_ENTITLEMENTS = Runner/Runner.entitlements"

project.save
puts "저장 완료"
