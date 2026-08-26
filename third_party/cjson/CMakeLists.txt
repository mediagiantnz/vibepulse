# Vendrad cJSON 1.7.18 (MIT) — samma parser på Macen som på kortet, annars
# är hosttesterna inte längre ett bevis om targetet. Kompileras EN gång här;
# apparna inkluderar headern med relativ sökväg.
idf_component_register(
  SRCS "cJSON.c"
  INCLUDE_DIRS ".")

# Nesting cap for the ONE cJSON compilation unit. cJSON's default limit is
# 1000 levels of recursion; the parsers run on 5-6 KB FreeRTOS task stacks,
# so a hostile "[[[[..." body would overflow the stack and panic the panel
# long before 1000. Every real payload (tokens "value" block, agent jobs,
# max-tracker day pairs) is at most four deep. Mirrored in sim/CMakeLists.txt
# and test/run.sh so the host proves the same parser the target runs.
target_compile_definitions(${COMPONENT_LIB} PRIVATE CJSON_NESTING_LIMIT=16)
