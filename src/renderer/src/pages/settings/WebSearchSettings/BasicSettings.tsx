import { useTheme } from '@renderer/context/ThemeProvider'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { setEnhanceMode, setMaxResult, setOverwrite, setSearchWithTime } from '@renderer/store/websearch'
import { Slider, Switch, Tooltip } from 'antd'
import { t } from 'i18next'
import { Info } from 'lucide-react'
import { FC } from 'react'

import { SettingDivider, SettingGroup, SettingRow, SettingRowTitle, SettingTitle } from '..'

const BasicSettings: FC = () => {
  const { theme } = useTheme()
  const searchWithTime = useAppSelector((state) => state.websearch.searchWithTime)
  const enhanceMode = useAppSelector((state) => state.websearch.enhanceMode)
  const overwrite = useAppSelector((state) => state.websearch.overwrite)
  const maxResults = useAppSelector((state) => state.websearch.maxResults)

  const dispatch = useAppDispatch()

  return (
    <>
      <SettingGroup theme={theme} style={{ paddingBottom: 8 }}>
        <SettingTitle>{t('settings.general.title')}</SettingTitle>
        <SettingDivider />
        <SettingRow>
          <SettingRowTitle>{t('settings.websearch.search_with_time')}</SettingRowTitle>
          <Switch checked={searchWithTime} onChange={(checked) => dispatch(setSearchWithTime(checked))} />
        </SettingRow>
        <SettingDivider style={{ marginTop: 15, marginBottom: 12 }} />
        <SettingRow>
          <SettingRowTitle>
            {t('settings.websearch.overwrite')}
            <Tooltip title={t('settings.websearch.overwrite_tooltip')} placement="right">
              <Info size={16} color="var(--color-icon)" style={{ marginLeft: 5, cursor: 'pointer' }} />
            </Tooltip>
          </SettingRowTitle>
          <Switch checked={overwrite} onChange={(checked) => dispatch(setOverwrite(checked))} />
        </SettingRow>
        <SettingDivider style={{ marginTop: 15, marginBottom: 12 }} />
        <SettingRow>
          <SettingRowTitle>
            {t('settings.websearch.enhance_mode')}
            <Tooltip title={t('settings.websearch.enhance_mode_tooltip')} placement="right">
              <Info size={16} color="var(--color-icon)" style={{ marginLeft: 5, cursor: 'pointer' }} />
            </Tooltip>
          </SettingRowTitle>
          <Switch checked={enhanceMode} onChange={(checked) => dispatch(setEnhanceMode(checked))} />
        </SettingRow>
        <SettingDivider style={{ marginTop: 15, marginBottom: 10 }} />
        <SettingRow style={{ height: 40 }}>
          <SettingRowTitle>{t('settings.websearch.search_max_result')}</SettingRowTitle>
          <Slider
            defaultValue={maxResults}
            style={{ width: '200px' }}
            min={1}
            max={20}
            step={1}
            marks={{ 1: '1', 5: t('settings.websearch.search_result_default'), 20: '20' }}
            onChangeComplete={(value) => dispatch(setMaxResult(value))}
          />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
export default BasicSettings
