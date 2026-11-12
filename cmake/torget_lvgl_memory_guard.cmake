set(TORGET_LVGL_POOL_MIN_KIB 256)

# The pool size LVGL will actually use, in KiB. LVGL 9.6 sizes its pool from
# CONFIG_LV_MEM_SIZE (bytes, default 64 KiB) and only keeps
# CONFIG_LV_MEM_SIZE_KILOBYTES as a deprecated, ignored leftover. Older 9.x
# has no byte option and uses the KiB one. Checking the KiB value alone let a
# 64 KiB pool through on 2026-11-12 (lvgl 9.5.0 -> 9.6.0 refetch): the boot
# wedged in LV_ASSERT_MALLOC inside torget_wifi_ui_create and the glass
# stayed black.
function(torget_lvgl_effective_pool_kib out mem_size_bytes mem_size_kib)
  if(NOT "${mem_size_bytes}" STREQUAL "")
    if(NOT "${mem_size_bytes}" MATCHES "^[0-9]+$")
      message(FATAL_ERROR
        "LVGL pool size is invalid: CONFIG_LV_MEM_SIZE='${mem_size_bytes}'")
    endif()
    math(EXPR kib "${mem_size_bytes} / 1024")
    set(${out} "${kib}" PARENT_SCOPE)
  else()
    set(${out} "${mem_size_kib}" PARENT_SCOPE)
  endif()
endfunction()

function(torget_require_lvgl_pool actual_kib)
  if("${actual_kib}" STREQUAL "" OR NOT "${actual_kib}" MATCHES "^[0-9]+$")
    message(FATAL_ERROR
      "LVGL pool size is missing or invalid: '${actual_kib}'")
  endif()

  if(actual_kib LESS TORGET_LVGL_POOL_MIN_KIB)
    math(EXPR min_bytes "${TORGET_LVGL_POOL_MIN_KIB} * 1024")
    message(FATAL_ERROR
      "LVGL pool is ${actual_kib} KiB; Torget requires at least "
      "${TORGET_LVGL_POOL_MIN_KIB} KiB. The generated sdkconfig is stale: "
      "edit sdkconfig and set "
      "CONFIG_LV_MEM_SIZE=${min_bytes} and "
      "CONFIG_LV_MEM_SIZE_KILOBYTES=${TORGET_LVGL_POOL_MIN_KIB} "
      "(matching sdkconfig.defaults), then run: "
      "idf.py reconfigure && idf.py build")
  endif()
endfunction()
