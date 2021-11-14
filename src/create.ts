#!/usr/bin/env node

import inquirer from 'inquirer'
import ora from 'ora'
import fs from 'fs'
import download from 'download-git-repo'
import concurrently from 'concurrently'
import chalk from 'chalk'
import { CNPM_URL } from './util/git'
import { hasProjectGit, sortPkg } from './util/index'
import handleEditor from './create/editor'
import handleCommitHook, { initLintStage } from './create/commitHook'
import handleEslint, { eslintConfigAddPrettier } from './create/eslint'
import handlePrettier from './create/prettier'
import handleVscode from './create/vscode'
import handleJest from './create/jest'
import handleUIComponents from './create/uiComponents'
import { questions, FunctionKeys, QuestionAnswers } from './create/index'

const spinner = ora()
spinner.color = 'green'

// 答案内容
let _answers: QuestionAnswers | null = null
// 项目路径
let _projectPath = ''

// 获取基础模板的release列表
inquirer.prompt(questions).then((answers: QuestionAnswers) => {
  // 获取答案, 把答案的内容赋值给全局
  _answers = answers
  // eslint-disable-next-line prefer-const
  let { template: templateUrl, projectName, version } = answers
  // 根据项目名称得到项目根路径
  _projectPath = `${process.cwd()}/${projectName}`
  // 处理templateUrl
  if (templateUrl.includes('direct')) {
    // 向templateUrl后面拼接版本号+zip格式
    // 如果是自定义版本就使用version值，如果用户选择了最新版本，就直接使用template-version（最新版本的版本值）
    templateUrl += `${answers['template-version'] === 'other' ? version : answers['template-version']}.zip`
  }
  spinner.start('下载模板中, 请稍后...')
  // 开始下载模板
  downloadTemplate({
    repository: templateUrl
  })
})

/**
 * @name 下载远端模板
 * @param {{ repository: string; }} params
 */
const downloadTemplate = (params: { repository: string }): void => {
  const { repository } = params
  download(repository, _answers?.projectName as string, (err) => {
    if (!err) {
      editPackageInfo()
    } else {
      console.log(err)
      spinner.stop() // 停止
      console.log(chalk.red('拉取模板出现未知错误'))
    }
  })
}

// 功能列表的回调字典，内部函数处理了对package的读写&处理文件等操作
const functionsCallBack: Record<FunctionKeys, (params: EditTemplate) => CreateFunctionRes> = {
  editor: (params: EditTemplate) => handleEditor(params),
  commitHook: (params: EditTemplate) => handleCommitHook(params),
  eslint: (params: EditTemplate) => handleEslint(params),
  prettier: (params: EditTemplate) => handlePrettier(params),
  vscode: (params: EditTemplate) => handleVscode(params),
  jest: (params: EditTemplate) => handleJest(params)
}

/**
 * @name 处理对应操作的函数
 * @description eslint, editor等等
 * @param {{ package: PackageData }} params
 * @return {*}  {Promise<void>}
 */

const handleFunctions = (params: { package: PackageData }): Promise<PackageData> => {
  const { functions: checkedfunctions } = _answers as QuestionAnswers
  return new Promise((resolve, reject) => {
    // 执行对应的回调函数
    try {
      checkedfunctions.map((c) => {
        params.package = functionsCallBack[c]({ ...params, path: _projectPath }).projectData
      })
      // 判断是否选择了eslint / prettier
      const isEslint = checkedfunctions.includes('eslint')
      const isPrettier = checkedfunctions.includes('prettier')
      // 处理函数中有一些部分比较复杂，比如lint和eslint的组合搭配，这部分我们封装到commithook钩子里面
      // 如果用户选择了commitHook，且要和eslint，prettier搭配
      if (checkedfunctions.includes('commitHook')) {
        initLintStage({
          isPrettier,
          isEslint,
          path: _projectPath
        })
      }
      // 如果二者都被选中，就需要eslint对prettier进行扩充，调用eslint中暴露的一个函数
      if (isEslint && isPrettier) {
        params.package = eslintConfigAddPrettier({ ...params, path: _projectPath }).projectData
      }
      // 执行uiComponents的逻辑，函数会动态根据用户选择的ui框架返回正确的依赖选项（package.json）
      params.package = handleUIComponents({
        package: params.package,
        path: _projectPath,
        name: _answers!.uiComponents
      })
    } catch (error) {
      reject(
        `处理用户选择的功能时出现了错误: ${error}; 请前往 https://github.com/seho-code-life/project_tool/issues/new 报告此错误; 但是这不影响你使用此模板，您可以自行删减功能`
      )
    }
    resolve(params.package)
  })
}

/**
 * @name 修改package信息（包括调用了处理操作的函数）
 * @description 修改版本号以及项目名称
 */
const editPackageInfo = (): void => {
  const { functions } = _answers as QuestionAnswers
  // 读取项目中的packagejson文件
  fs.readFile(`${_projectPath}/package.json`, async (err, data) => {
    if (err) throw err
    // 获取json数据并修改项目名称和版本号
    let _data = JSON.parse(data.toString())
    // 修改package的name名称
    _data.name = _answers?.projectName
    if (functions) {
      // 处理functions, 去在模板中做一些其他操作，比如删除几行依赖/删除几个文件
      try {
        // handleFunctions函数返回的_data就是处理过的package信息
        _data = await handleFunctions({
          package: _data
        })
      } catch (error) {
        spinner.text = `${error}`
        spinner.fail()
      }
    }
    const str = JSON.stringify(sortPkg(_data), null, 2)
    // 写入文件
    fs.writeFile(`${_projectPath}/package.json`, str, function (err) {
      if (err) throw err
      spinner.text = `下载完成, 正在自动安装项目依赖...`
      install()
    })
  })
}

/**
 * @name 对项目进行install安装依赖操作
 */
const install = async () => {
  const { projectName, functions } = _answers as QuestionAnswers
  const cwd = `${process.cwd()}/${projectName}`
  spinner.text = '🤔 自动安装&初始化项目中...'
  // 执行install
  // 删除空文件夹中的gitkeep 占位文件
  // 初始化git
  // 如果用户选择了拦截钩子，就初始化husky pre commit
  try {
    await concurrently([`npm --registry ${CNPM_URL} i`, `find ./ -type f -name '.gitkeep' -delete`], { cwd, raw: true })
    const hasGit = hasProjectGit(cwd)
    // 如果初始化git成功/本身具有git目录，就进入 添加husky命令 的逻辑
    if (hasGit) {
      if (functions && functions.includes('commitHook')) {
        // 执行husky命令时，需要首先执行预定义好的npm run prepare 再执行 add的操作
        await concurrently([`npm run prepare && npx husky add .husky/pre-commit "npm run lint-staged"`], { cwd, raw: false })
      }
    }
    spinner.text = `✌️ 安装成功, 进入${projectName}开始撸码～`
    spinner.succeed()
  } catch (error) {
    spinner.text = `自动安装失败, 请查看错误，且之后自行安装依赖～`
    spinner.fail()
    console.error(error)
  }
}
