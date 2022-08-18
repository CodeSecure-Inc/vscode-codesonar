import os

Import('env')


VSIX_EXT = '.vsix'

csonar_vscode_pkg_name = 'vscode-codesonar'
csonar_vscode_version_str = env['CSONAR_VSCODE_VERSION']
csonar_vscode_protocol_num = env['CSONAR_VSCODE_HUB_PROTOCOL_VERSION']


def file_content_sub(outfile, infile, repls):
    """ Substitute a dict of token name,value pairs from a source file to a target file. """
    with open(infile, 'r') as in_io:
        file_contents = in_io.read()
    for sub, repl in repls.items():
        file_contents = file_contents.replace(sub, repl)
    with open(outfile, 'w') as out_io:
        out_io.write(file_contents)


def update_extension_version_module(target, source, env):
    """ Replace plugin package name and version number in package.json """
    extension_version_target = target[0]
    extension_version_source, version_string_source, protocol_number_source = source
    version_string = version_string_source.get_text_contents()
    protocol_number_string = protocol_number_source.get_text_contents()
    file_content_sub(
        extension_version_target.abspath,
        extension_version_source.abspath,
        {
            '__CSONAR_VSCODE_VERSION__': version_string,
            '__CSONAR_VSCODE_PROTOCOL_NUMBER__': protocol_number_string,
        })

def update_extension_version_module_action_formatter(target, source, env):
    return 'cso_vscode_update_extension_version(%s, ...)' % target[0].path


extension_version_ts = env.Command(
    [
        'src/extension_version.ts'
    ],
    [
        'extension_version.ts.in',
        Value(csonar_vscode_version_str),
        Value(str(csonar_vscode_protocol_num)),
    ],
    env.Action(
        update_extension_version_module,
        update_extension_version_module_action_formatter),
    )


def update_npm_package_json(target, source, env):
    """ Replace plugin package name and version number in package.json """
    package_json_target = target[0]
    package_json_source, package_name_source, version_str_source = source
    package_name = package_name_source.get_text_contents()
    version_string = version_str_source.get_text_contents()
    file_content_sub(
        package_json_target.abspath,
        package_json_source.abspath,
        {
            '$(CSO_VSCODE_PACKAGE_NAME)': package_name,
            '$(CSO_VSCODE_VERSION)': version_string,
        })

def update_package_json_action_formatter(target, source, env):
    return 'cso_vscode_update_package_json(%s, ...)' % target[0].path


npm_package_json = env.Command(
    [
        'package.json'
    ],
    [
        'package.json.in',
        Value(csonar_vscode_pkg_name),
        Value(csonar_vscode_version_str),
    ],
    env.Action(
        update_npm_package_json,
        update_package_json_action_formatter),
    )

# package-lock.json is both a build source and target,
#  Use a .in file and a Copy PreAction to avoid SCons dependency resolution problems:
#  See also SCons code in codesonar/py/hub/media/nodejs/angular/**.
npm_package_lock_source = File('package-lock.json.in')

node_modules = env.NPM(
    [ProxyDir('node_modules')],
    [
        npm_package_json,
        npm_package_lock_source,
    ],
    NPM_COMMAND=['install'])

# Use Copy PreAction to avoid SCons dependency resolution problems:
env.AddPreAction(
    node_modules,
    Copy(
        File('package-lock.json'),
        npm_package_lock_source))


cso_vscode_pkg = Dir('.')

cso_vscode_deps = node_modules
cso_vscode_deps += [File(x) for x in [
    'tsconfig.json',
    '.vscodeignore',
]]
cso_vscode_deps = sorted(cso_vscode_deps)

cso_vscode_project_source = env.GTFindFiles('src')
cso_vscode_project_source += extension_version_ts
cso_vscode_project_source += [File(x) for x in [
    "README.md",
    "CHANGELOG.md",
    "LICENSE.txt",
]]
cso_vscode_project_source = sorted(cso_vscode_project_source)

csonar_vscode_extension_vsix_fname = f'{csonar_vscode_pkg_name}-{csonar_vscode_version_str}{VSIX_EXT}'

csonar_vscode_extension_vsix = env.NPM(
    csonar_vscode_extension_vsix_fname,
    cso_vscode_project_source,
    NPM_PKG_ROOT=cso_vscode_pkg,
    NPM_COMMAND=[
        'run',
        'vsix',
    ],
)

env.Depends(
    csonar_vscode_extension_vsix,
    cso_vscode_deps)

# Remove all (old) .vsix files when we clean:
env.Clean(csonar_vscode_extension_vsix, env.Glob(f'*{VSIX_EXT}'))

env.GTDefault(csonar_vscode_extension_vsix)

env.GTCreateFeature(
    'csonar_vscode_extension',
    installed_files=env.GTDefault(csonar_vscode_extension_vsix)
)

