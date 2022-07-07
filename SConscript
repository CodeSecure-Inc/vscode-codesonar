import os

Import('env')

# Much of this SCons code originates from codesonar/py/hub/media/nodejs/angular/**

node_modules = env.NPM(
    [ProxyDir('node_modules')],
    [
        'package.json',
        'package-lock.json.in',
    ],
    NPM_COMMAND=['install'])

# package-lock.json is both a build source and target,
#  Use a .in file and a Copy PreAction to avoid SCons dependency resolution problems:
env.AddPreAction(
    node_modules,
    Copy(
        File('package-lock.json'), 
        File('package-lock.json.in')
    ))


cso_vscode_pkg = Dir('.')
cso_vscode_dist = Dir('out')
cso_vscode_root = node_modules + [
    File('tsconfig.json'),
#    File('tslint.json'),
]


cso_vscode_project_source = sorted(env.GTFindFiles('src'))

csonar_vscode_pkg_name = "vscode-codesonar"
# TODO read version number from centralized location:
csonar_vscode_version_str = "0.0.1"
csonar_vscode_extension_vsix_fname = f"${csonar_vscode_pkg_name}-${csonar_vscode_version_str}"
csonar_vscode_extension_vsix = env.NPM(
    csonar_vscode_extension_vsix_fname,
    cso_vscode_project_source,
    NPM_PKG_ROOT=cso_vscode_pkg,
    NPM_COMMAND=[
        'run',
        'vsix',
        '--',
    ],
)

env.Depends(csonar_vscode_extension_vsix, node_modules)

    
env.GTCreateFeature(
    'csonar_vscode_extension',
    installed_files=env.GTDefault(csonar_vscode_extension_vsix)
)
